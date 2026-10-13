import { describe, expect, it } from 'vitest';
import { streamJsonArrayElements, JsonStreamError } from '../src/lib/json-stream.js';

/** Feed a string as bytes in fixed-size chunks, so chunk boundaries land mid-token. */
async function* chunked(text: string, size: number): AsyncGenerator<Buffer> {
  const bytes = Buffer.from(text, 'utf8');
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

async function collect(text: string, size = 4096, options?: Parameters<typeof streamJsonArrayElements>[1]) {
  const out: unknown[] = [];
  for await (const element of streamJsonArrayElements(chunked(text, size), options)) out.push(element);
  return out;
}

/**
 * The scanner replaces `JSON.parse` over the whole export, so it has to agree
 * with it exactly — including at every possible chunk boundary, which is the
 * failure mode a naive implementation only hits in production on a big file.
 */
describe('streamJsonArrayElements', () => {
  it('reads a bare top-level array', async () => {
    expect(await collect('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('reads the array out of an object root', async () => {
    expect(await collect('{"conversations":[{"a":1},{"a":2}]}')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('skips other root keys, whatever they contain', async () => {
    const text = '{"meta":{"nested":[1,2,{"deep":"]}"}]},"count":7,"flag":true,"conversations":[{"a":1}],"trailing":"x"}';
    expect(await collect(text)).toEqual([{ a: 1 }]);
  });

  it('finds the array when it is the last key', async () => {
    expect(await collect('{"a":1,"b":[1,2,3],"conversations":[{"z":9}]}')).toEqual([{ z: 9 }]);
  });

  it('honours a custom set of accepted keys', async () => {
    expect(await collect('{"chats":[{"a":1}]}', 4096, { arrayKeys: ['chats'] })).toEqual([{ a: 1 }]);
  });

  it('returns nothing for an empty array', async () => {
    expect(await collect('[]')).toEqual([]);
    expect(await collect('{"conversations":[]}')).toEqual([]);
  });

  it('tolerates whitespace anywhere', async () => {
    expect(await collect('  \n\t [ \n {"a":1} , \r\n {"a":2} \n ] \n ')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  /**
   * The case that matters most. Structural bytes are ASCII and UTF-8 is
   * self-synchronizing, so a chunk may split a multi-byte character, a string,
   * an escape pair, or a bracket run — at any offset — and the result must not
   * change.
   */
  it('produces identical output at every chunk size', async () => {
    const text = JSON.stringify([
      { id: 'a', title: '한국어 제목', body: 'brackets [ ] { } and "quotes"' },
      { id: 'b', nested: { deep: [1, [2, [3, { s: 'x],[y' }]]] } },
      { id: 'c', escaped: 'back\\slash and \\"escaped quote\\" and \\\\', emoji: '🧠📦' },
      { id: 'd', n: -12.5e3, t: true, f: false, z: null }
    ]);
    const expected = JSON.parse(text);
    for (let size = 1; size <= 40; size++) {
      expect(await collect(text, size), `chunk size ${size}`).toEqual(expected);
    }
    for (const size of [64, 127, 256, 1024]) {
      expect(await collect(text, size), `chunk size ${size}`).toEqual(expected);
    }
  });

  it('splits an object root at every chunk size too', async () => {
    const text = '{"meta":{"a":"]"},"conversations":[{"k":"v,"},{"k":"}"}]}';
    const expected = [{ k: 'v,' }, { k: '}' }];
    for (let size = 1; size <= 30; size++) {
      expect(await collect(text, size), `chunk size ${size}`).toEqual(expected);
    }
  });

  it('keeps brackets and commas inside strings out of the structure', async () => {
    expect(await collect('[{"s":"[{,}]"},{"s":"\\"]"}]')).toEqual([{ s: '[{,}]' }, { s: '"]' }]);
  });

  it('handles an escaped backslash immediately before a quote', async () => {
    // "a\\" is a string ending in one backslash — the quote after it really closes it.
    expect(await collect('[{"s":"a\\\\"},{"t":1}]')).toEqual([{ s: 'a\\' }, { t: 1 }]);
  });

  it('reads primitive and array elements, not just objects', async () => {
    expect(await collect('[1,2,3]')).toEqual([1, 2, 3]);
    expect(await collect('["a","b"]')).toEqual(['a', 'b']);
    expect(await collect('[[1,2],[3]]')).toEqual([[1, 2], [3]]);
    expect(await collect('[true,false,null,-1.5e2]')).toEqual([true, false, null, -150]);
  });

  it('terminates a trailing primitive at end of input', async () => {
    // No closing bracket: the last number still has to come out, and the
    // truncation must be reported rather than silently dropping it.
    await expect(collect('[1,2')).rejects.toThrow(JsonStreamError);
  });

  it('streams lazily — it does not read the whole source up front', async () => {
    let produced = 0;
    async function* counted(): AsyncGenerator<Buffer> {
      const parts = ['[', '{"a":1},', '{"a":2},', '{"a":3}', ']'];
      for (const p of parts) { produced++; yield Buffer.from(p); }
    }
    const iterator = streamJsonArrayElements(counted());
    const first = await iterator.next();
    expect(first.value).toEqual({ a: 1 });
    // Only the chunks needed for the first element have been pulled.
    expect(produced).toBeLessThan(5);
    await iterator.return(undefined);
  });

  it('stops reading once the array closes', async () => {
    let pulled = 0;
    async function* withTrailingGarbage(): AsyncGenerator<Buffer> {
      pulled++; yield Buffer.from('[{"a":1}]');
      pulled++; yield Buffer.from('this would not parse');
    }
    const out: unknown[] = [];
    for await (const e of streamJsonArrayElements(withTrailingGarbage())) out.push(e);
    expect(out).toEqual([{ a: 1 }]);
    expect(pulled).toBe(1);
  });

  describe('rejections', () => {
    it('rejects a root that is neither array nor object', async () => {
      await expect(collect('"just a string"')).rejects.toThrow(/must be an array/);
      await expect(collect('42')).rejects.toThrow(/must be an array/);
    });

    it('rejects an object root with no conversations array', async () => {
      await expect(collect('{"a":1,"b":2}')).rejects.toThrow(/no conversations array/);
    });

    it('reports a truncated element rather than yielding a partial one', async () => {
      await expect(collect('[{"a":1},{"b":')).rejects.toThrow(/truncated/);
    });

    it('rejects an element larger than the cap, without buffering it all', async () => {
      const big = JSON.stringify([{ pad: 'x'.repeat(5000) }]);
      await expect(collect(big, 512, { maxElementBytes: 1024 })).rejects.toThrow(/exceeds the 1024-byte limit/);
    });

    it('rejects a malformed element with a clear message', async () => {
      await expect(collect('[{"a":1,}]')).rejects.toThrow(/Invalid JSON element/);
    });

    it('rejects unbalanced brackets', async () => {
      await expect(collect('[{"a":1}}]')).rejects.toThrow(JsonStreamError);
    });
  });

  describe('scale', () => {
    it('reads far more elements than would fit comfortably in one parse', async () => {
      // 20k conversations of ~1 KB each: ~20 MB of JSON streamed through in
      // small chunks, proving the reader is bounded by element size, not input
      // size. The real 1.9 GB case is the same loop with more iterations.
      const element = (i: number) => JSON.stringify({ id: `c${i}`, pad: 'y'.repeat(1000) });
      async function* source(): AsyncGenerator<Buffer> {
        yield Buffer.from('[');
        for (let i = 0; i < 20_000; i++) yield Buffer.from((i ? ',' : '') + element(i));
        yield Buffer.from(']');
      }
      let count = 0;
      let last: any = null;
      for await (const e of streamJsonArrayElements(source())) { count++; last = e; }
      expect(count).toBe(20_000);
      expect(last.id).toBe('c19999');
    });
  });
});
