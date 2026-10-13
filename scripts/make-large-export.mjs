/**
 * Generate a realistically-shaped large ChatGPT export ZIP for manual
 * verification of the streaming import path.
 *
 * NOT part of the test suite, on purpose: a multi-gigabyte fixture has no
 * business in CI (the suite covers the same reader exhaustively with small
 * inputs and a bounded-memory assertion). This exists so the 1.9 GB case can be
 * exercised against a running server by hand.
 *
 *   node scripts/make-large-export.mjs <out.zip> <conversations> <mediaBytes>
 *
 * The archive mirrors a real export: one conversations.json plus a pile of
 * already-compressed media. Media is written with ZipPassThrough (stored, not
 * deflated) because that is what a ZIP of PNGs and audio actually looks like —
 * and it keeps the archive's size honest instead of compressing away to nothing.
 *
 * The writer itself is streaming, so generating a 1.9 GB archive costs ~1 MB of
 * memory, not 1.9 GB.
 */
import { createWriteStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';

const [outPath, conversationCountRaw, mediaBytesRaw] = process.argv.slice(2);
if (!outPath) {
  console.error('usage: node scripts/make-large-export.mjs <out.zip> [conversations] [mediaBytes]');
  process.exit(1);
}
const conversationCount = Number(conversationCountRaw ?? 20000);
const mediaBytes = Number(mediaBytesRaw ?? 0);

const out = createWriteStream(outPath);
let pendingDrain = null;

/** Backpressure: fflate pushes synchronously, so buffer writes and await drain between pushes. */
function write(chunk) {
  if (!out.write(Buffer.from(chunk))) pendingDrain = once(out, 'drain');
}
async function settle() {
  if (pendingDrain) { await pendingDrain; pendingDrain = null; }
}

const zip = new Zip();
zip.ondata = (err, chunk, final) => {
  if (err) { console.error('zip error:', err); process.exit(1); }
  if (chunk?.length) write(chunk);
  if (final) out.end();
};

/** One ChatGPT conversation: the real mapping/current_node graph the parser walks. */
function conversation(i) {
  const userText = i % 7 === 0
    ? `프로젝트 ${i} 배포 방식은 Docker로 결정했다.`
    : `대화 ${i}: ${'실제 대화처럼 충분한 길이의 한국어 본문을 담는다. '.repeat(6)}`;
  return {
    id: `large-${i}`,
    title: `Large export conversation ${i}`,
    create_time: 1700000000 + i,
    update_time: 1700000100 + i,
    current_node: 'b',
    mapping: {
      root: { id: 'root', parent: null, children: ['a'], message: null },
      a: { id: 'a', parent: 'root', children: ['b'], message: { id: `m-${i}-a`, author: { role: 'user' }, create_time: 1700000000 + i, content: { content_type: 'text', parts: [userText] }, metadata: { model_slug: 'gpt-4' } } },
      b: { id: 'b', parent: 'a', children: [], message: { id: `m-${i}-b`, author: { role: 'assistant' }, create_time: 1700000050 + i, content: { content_type: 'text', parts: [`응답 ${i}: ${'assistant 응답 본문. '.repeat(8)}`] }, metadata: { model_slug: 'gpt-4' } } }
    }
  };
}

// --- conversations.json, deflated, streamed one conversation at a time ---
const json = new ZipDeflate('export/conversations.json', { level: 6 });
zip.add(json);
let jsonBytes = 0;
const pushJson = (text, final = false) => {
  const bytes = Buffer.from(text, 'utf8');
  jsonBytes += bytes.length;
  json.push(bytes, final);
};
pushJson('[');
for (let i = 0; i < conversationCount; i++) {
  pushJson((i ? ',' : '') + JSON.stringify(conversation(i)));
  if (i % 2000 === 0) {
    await settle();
    process.stdout.write(`\r  conversations: ${i}/${conversationCount}  json ${(jsonBytes / 1e6).toFixed(0)} MB`);
  }
}
pushJson(']', true);
await settle();
process.stdout.write(`\r  conversations: ${conversationCount}/${conversationCount}  json ${(jsonBytes / 1e6).toFixed(0)} MB\n`);

// --- media: stored, not compressed, so the archive size is real ---
if (mediaBytes > 0) {
  const block = randomBytes(1024 * 1024); // reused: ZipPassThrough stores verbatim
  let remaining = mediaBytes;
  let fileIndex = 0;
  while (remaining > 0) {
    const size = Math.min(remaining, 64 * 1024 * 1024);
    const entry = new ZipPassThrough(`export/media/asset-${fileIndex++}.bin`);
    zip.add(entry);
    let left = size;
    while (left > 0) {
      const n = Math.min(left, block.length);
      entry.push(block.subarray(0, n), left - n === 0);
      left -= n;
      await settle();
    }
    remaining -= size;
    process.stdout.write(`\r  media: ${((mediaBytes - remaining) / 1e9).toFixed(2)} / ${(mediaBytes / 1e9).toFixed(2)} GB`);
  }
  process.stdout.write('\n');
}

zip.end();
await once(out, 'close');
const { statSync } = await import('node:fs');
const size = statSync(outPath).size;
console.log(`wrote ${outPath}: ${size} bytes (${(size / 1e9).toFixed(2)} GB), ${conversationCount} conversations, json ${(jsonBytes / 1e6).toFixed(0)} MB uncompressed`);
