/**
 * One-shot local tool: download the packages a Claude export manifest lists.
 *
 * NOT part of the product and not called by the server — the manifest import
 * route does this itself. This exists because a Claude export_url may be used
 * exactly once, so the structures inside those ZIPs had to be captured to a
 * durable directory before any parser could be written against them. Keeping the
 * tool means the capture is repeatable for a future export format change.
 *
 *   node scripts/fetch-claude-export.mjs <manifest.json> <output-dir>
 *
 * It prints the redirect chain for each file (hosts only, tokens masked) so the
 * production allowlist can be narrowed to what Claude actually uses.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseClaudeManifest } from '../dist/src/services/claude-manifest-service.js';
import { downloadExportPackage, maskUrl, allowedHosts } from '../dist/src/services/claude-download-service.js';

const [manifestPath, outDir] = process.argv.slice(2);
if (!manifestPath || !outDir) {
  console.error('usage: node scripts/fetch-claude-export.mjs <manifest.json> <output-dir>');
  process.exit(1);
}

const manifest = parseClaudeManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
await fs.mkdir(outDir, { recursive: true });

console.log(`manifest version ${manifest.version}, ${manifest.files.length} files`);
console.log(`allowlist: ${allowedHosts().join(', ')}`);
console.log();

const results = [];
for (const [index, file] of manifest.files.entries()) {
  const target = path.join(outDir, file.filename);
  const existing = await fs.stat(target).catch(() => null);
  if (existing?.size) {
    console.log(`[${index + 1}/${manifest.files.length}] ${file.category.padEnd(15)} SKIP (already have ${existing.size} bytes)`);
    results.push({ category: file.category, filename: file.filename, bytes: existing.size, skipped: true });
    continue;
  }

  // Log every hop: this is how the shipped allowlist gets narrowed to reality.
  const hops = [];
  const tracingFetch = async (input, init) => {
    hops.push(new URL(String(input)).host);
    return fetch(input, init);
  };

  process.stdout.write(`[${index + 1}/${manifest.files.length}] ${file.category.padEnd(15)} ${maskUrl(file.exportUrl)} … `);
  try {
    const result = await downloadExportPackage(file.exportUrl, target, { fetchImpl: tracingFetch });
    console.log(`OK ${result.bytes} bytes, ${result.redirects} redirect(s)`);
    console.log(`      hosts: ${[...new Set(hops)].join(' -> ')}`);
    results.push({ category: file.category, filename: file.filename, bytes: result.bytes, redirects: result.redirects, hosts: [...new Set(hops)] });
  } catch (error) {
    console.log(`FAILED ${error?.code ?? ''} ${error?.message ?? error}`);
    console.log(`      hosts attempted: ${[...new Set(hops)].join(' -> ') || '(none)'}`);
    results.push({ category: file.category, filename: file.filename, error: error?.code ?? String(error), hosts: [...new Set(hops)] });
  }
}

console.log();
console.log('summary:');
for (const r of results) {
  console.log('  ' + JSON.stringify(r));
}
