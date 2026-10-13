/**
 * Incremental reader for a JSON array of records, one element at a time.
 *
 * Why this exists: a provider export's conversations.json is the largest thing
 * DAMC ingests — a 1.9 GB ChatGPT ZIP expands to a JSON file well past a
 * gigabyte. The obvious pipeline (read file -> decode to string -> JSON.parse)
 * fails three ways at that size: the whole file lands in memory, V8 refuses
 * strings beyond its maximum length, and the parsed object graph costs several
 * times the text again. None of that is necessary, because the file is a *list*
 * and DAMC imports it one conversation at a time.
 *
 * So this scans bytes and yields one element at a time. Peak memory is one input
 * chunk plus the single largest element, never the file.
 *
 * Scanning bytes rather than decoded text is safe and deliberate: every byte
 * with structural meaning in JSON ({ } [ ] " \ , :) is ASCII, and UTF-8 never
 * encodes a non-ASCII character using an ASCII byte. A multi-byte character can
 * therefore be split across chunks without the scanner mis-reading it, and each
 * element is decoded only once it is complete.
 *
 * It accepts both export shapes DAMC already supported: a bare top-level array,
 * and an object with the array under a named key ({"conversations": [...]}).
 */

const TAB = 0x09, LF = 0x0a, CR = 0x0d, SPACE = 0x20;
const QUOTE = 0x22, COMMA = 0x2c, COLON = 0x3a;
const OPEN_BRACKET = 0x5b, CLOSE_BRACKET = 0x5d;
const OPEN_BRACE = 0x7b, CLOSE_BRACE = 0x7d;
const BACKSLASH = 0x5c;

function isWhitespace(byte: number): boolean {
  return byte === SPACE || byte === TAB || byte === LF || byte === CR;
}

/** Bytes that can end an unquoted primitive (number, true, false, null). */
function isValueTerminator(byte: number): boolean {
  return isWhitespace(byte) || byte === COMMA || byte === CLOSE_BRACKET || byte === CLOSE_BRACE;
}

export class JsonStreamError extends Error {}

export interface JsonArrayStreamOptions {
  /**
   * Keys to accept when the root is an object rather than an array. The first
   * matching key whose value is an array is the one streamed.
   */
  arrayKeys?: string[];
  /**
   * Cap on a single element's encoded size. A legitimate conversation is well
   * under a megabyte; a much larger one means the input is not what it claims to
   * be, and accumulating it would defeat the point of streaming.
   */
  maxElementBytes?: number;
}

const DEFAULT_MAX_ELEMENT_BYTES = 64 * 1024 * 1024;

/**
 * Resumable scanner for exactly one JSON value.
 *
 * Fed bytes across arbitrary chunk boundaries, it reports the offset at which
 * the value ended. Depth and string state persist between calls, which is what
 * makes a value larger than one chunk work.
 */
class ValueScanner {
  private depth = 0;
  private inString = false;
  private escaped = false;
  private started = false;
  private primitive = false;

  reset(): void {
    this.depth = 0;
    this.inString = false;
    this.escaped = false;
    this.started = false;
    this.primitive = false;
  }

  /**
   * Consume from `buffer` starting at `start`.
   * Returns the index just past the value's last byte once complete, or -1 when
   * more input is needed. For a primitive the terminating byte is NOT consumed —
   * it belongs to whatever separates elements.
   */
  consume(buffer: Buffer, start: number): number {
    let i = start;
    for (; i < buffer.length; i++) {
      const byte = buffer[i]!;

      if (this.inString) {
        if (this.escaped) { this.escaped = false; continue; }
        if (byte === BACKSLASH) { this.escaped = true; continue; }
        if (byte === QUOTE) {
          this.inString = false;
          // A bare string value is finished at its closing quote.
          if (this.depth === 0) return i + 1;
        }
        continue;
      }

      if (this.primitive) {
        if (isValueTerminator(byte)) return i;
        continue;
      }

      if (byte === QUOTE) {
        this.inString = true;
        this.started = true;
        continue;
      }
      if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
        this.depth++;
        this.started = true;
        continue;
      }
      if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
        this.depth--;
        if (this.depth === 0) return i + 1;
        if (this.depth < 0) throw new JsonStreamError('Unbalanced bracket in JSON input');
        continue;
      }
      if (!this.started) {
        if (isWhitespace(byte)) continue;
        // Anything else starting a value is a primitive literal.
        this.started = true;
        this.primitive = true;
        continue;
      }
    }
    return -1;
  }

}

type Phase =
  | 'seek-root'
  | 'object-key'
  | 'object-colon'
  | 'object-value'
  | 'skip-value'
  | 'array'
  | 'element'
  | 'done';

/** Index just past the closing quote of the JSON string at `start`, or -1 if it is not all here yet. */
function findStringEnd(buffer: Buffer, start: number): number {
  let escaped = false;
  for (let i = start + 1; i < buffer.length; i++) {
    const byte = buffer[i]!;
    if (escaped) { escaped = false; continue; }
    if (byte === BACKSLASH) { escaped = true; continue; }
    if (byte === QUOTE) return i + 1;
  }
  return -1;
}

/**
 * Yield each element of the JSON array found in `source`.
 *
 * `source` is any async iterable of byte chunks — a file read stream, a
 * decompressed ZIP entry, or a fixture in tests.
 */
export async function* streamJsonArrayElements(
  source: AsyncIterable<Buffer | Uint8Array>,
  options: JsonArrayStreamOptions = {}
): AsyncGenerator<unknown, void, undefined> {
  const arrayKeys = new Set((options.arrayKeys ?? ['conversations']).map(k => k.toLowerCase()));
  const maxElementBytes = options.maxElementBytes ?? DEFAULT_MAX_ELEMENT_BYTES;

  let phase: Phase = 'seek-root';
  // Tracked separately from `phase` so the loop and the end-of-input checks can
  // test for completion without TypeScript narrowing `phase` to the states that
  // happen to be assigned inside the switch.
  let finished = false;
  let pending: Buffer = Buffer.alloc(0);
  const scanner = new ValueScanner();

  // Accumulated bytes of the element currently being read, plus the key scanner
  // state used only while locating the array inside an object root.
  let elementChunks: Buffer[] = [];
  let elementBytes = 0;
  let currentKeyMatches = false;
  let sawRootArray = false;

  const takeElement = (): unknown => {
    const text = Buffer.concat(elementChunks).toString('utf8');
    elementChunks = [];
    elementBytes = 0;
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new JsonStreamError(`Invalid JSON element: ${error instanceof Error ? error.message : 'parse failed'}`);
    }
  };

  const addElementBytes = (chunk: Buffer) => {
    elementBytes += chunk.length;
    if (elementBytes > maxElementBytes) {
      throw new JsonStreamError(`A single JSON element exceeds the ${maxElementBytes}-byte limit`);
    }
    elementChunks.push(chunk);
  };

  for await (const raw of source) {
    if (finished) break;
    const chunk: Buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let cursor = 0;

    // Each iteration either advances `cursor` or needs more input and breaks.
    scanning: while (cursor < pending.length) {
      switch (phase) {
        case 'seek-root': {
          while (cursor < pending.length && isWhitespace(pending[cursor]!)) cursor++;
          if (cursor >= pending.length) break scanning;
          const byte = pending[cursor]!;
          if (byte === OPEN_BRACKET) {
            cursor++;
            sawRootArray = true;
            phase = 'array';
            continue;
          }
          if (byte === OPEN_BRACE) {
            cursor++;
            phase = 'object-key';
            continue;
          }
          throw new JsonStreamError('Export JSON must be an array of conversations, or an object containing one');
        }

        case 'object-key': {
          while (cursor < pending.length && (isWhitespace(pending[cursor]!) || pending[cursor] === COMMA)) cursor++;
          if (cursor >= pending.length) break scanning;
          if (pending[cursor] === CLOSE_BRACE) {
            // Root object ended without the array key. `sawRootArray` stays false,
            // which the end-of-input check below turns into a clear error.
            cursor++;
            phase = 'done';
            finished = true;
            break scanning;
          }
          if (pending[cursor] !== QUOTE) throw new JsonStreamError('Malformed object key in export JSON');
          // A key split across chunks simply is not consumed: `cursor` stays put,
          // the partial key is retained as the pending tail, and the next chunk
          // completes it. Same mechanism every other phase uses.
          const end = findStringEnd(pending, cursor);
          if (end < 0) break scanning;
          const key = JSON.parse(pending.subarray(cursor, end).toString('utf8')) as string;
          currentKeyMatches = arrayKeys.has(String(key).toLowerCase());
          cursor = end;
          phase = 'object-colon';
          continue;
        }

        case 'object-colon': {
          while (cursor < pending.length && isWhitespace(pending[cursor]!)) cursor++;
          if (cursor >= pending.length) break scanning;
          if (pending[cursor] !== COLON) throw new JsonStreamError('Expected ":" after object key in export JSON');
          cursor++;
          phase = 'object-value';
          continue;
        }

        case 'object-value': {
          while (cursor < pending.length && isWhitespace(pending[cursor]!)) cursor++;
          if (cursor >= pending.length) break scanning;
          if (currentKeyMatches && pending[cursor] === OPEN_BRACKET) {
            cursor++;
            sawRootArray = true;
            phase = 'array';
            continue;
          }
          // Not the array we want: skip this value wholesale.
          scanner.reset();
          phase = 'skip-value';
          continue;
        }

        case 'skip-value': {
          const end = scanner.consume(pending, cursor);
          if (end < 0) {
            cursor = pending.length;
            break scanning;
          }
          cursor = end;
          phase = 'object-key';
          continue;
        }

        case 'array': {
          while (cursor < pending.length && (isWhitespace(pending[cursor]!) || pending[cursor] === COMMA)) cursor++;
          if (cursor >= pending.length) break scanning;
          if (pending[cursor] === CLOSE_BRACKET) {
            cursor++;
            phase = 'done';
            finished = true;
            break scanning;
          }
          scanner.reset();
          phase = 'element';
          continue;
        }

        case 'element': {
          const end = scanner.consume(pending, cursor);
          if (end < 0) {
            addElementBytes(pending.subarray(cursor));
            cursor = pending.length;
            break scanning;
          }
          addElementBytes(pending.subarray(cursor, end));
          cursor = end;
          phase = 'array';
          yield takeElement();
          continue;
        }

        case 'done':
          break scanning;
      }
    }

    pending = cursor > 0 ? pending.subarray(cursor) : pending;
    if (finished) break;
  }

  // End of input. Every valid shape ends with the array's closing bracket, so
  // anything else means the file was cut off — never silently import a prefix of
  // a truncated export.
  if (!finished) {
    if (phase === 'element' || phase === 'array') {
      throw new JsonStreamError('Export JSON ended in the middle of the conversations array (file truncated?)');
    }
    throw new JsonStreamError('Export JSON contains no conversations array');
  }
  if (!sawRootArray) {
    throw new JsonStreamError('Export JSON contains no conversations array');
  }
}
