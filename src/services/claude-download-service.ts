/**
 * Fetching a Claude export package, server-side.
 *
 * The manifest hands DAMC a list of URLs supplied by a file the user uploaded.
 * Fetching a user-supplied URL from the server is a server-side request forgery
 * primitive unless it is constrained, so nothing here fetches anything the
 * allowlist has not approved — every hop, not just the first.
 *
 * Three properties this module has to hold:
 *
 *   ALLOWLIST BY HOST, NOT BY PATTERN. Only hosts in DAMC_CLAUDE_DOWNLOAD_HOSTS
 *   (claude.ai by default) are fetched. A manifest naming any other host is
 *   refused before a socket is opened.
 *
 *   RE-VALIDATE REDIRECTS. Redirects are followed manually rather than by fetch,
 *   because `redirect: 'follow'` would send the request wherever the first
 *   response points — which is the whole attack. Each Location is checked against
 *   the same rules.
 *
 *   RESOLVE BEFORE CONNECTING. An allowlisted hostname that resolves to
 *   127.0.0.1 or 10.x is still an internal request. The host is resolved and the
 *   addresses checked, which closes the obvious DNS trick. It does not close a
 *   rebinding race between this check and the connection — that would need a
 *   pinned-IP agent — and the host allowlist is what actually carries the weight.
 *
 * Nothing here logs a full URL: an export_url is a bearer credential.
 */

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import dns from 'node:dns/promises';
import { env } from '../config/env.js';
import { AppError } from '../errors/app-error.js';
import { isPrivateAddress } from '../lib/ip.js';
import { readFileHead as readHead, looksLikeZip } from './import-upload-service.js';

const MAX_REDIRECTS = 5;

/**
 * Is this response a bot-protection interstitial rather than the file?
 *
 * Cloudflare marks a mitigated request with `cf-mitigated`, and serves HTML
 * either way. DAMC reports this and stops; it does not try to look like a
 * browser to get past it. Defeating bot protection is out of scope by policy,
 * and a downloader that pretends to be Chrome is exactly what that policy is
 * about.
 */
function isBotChallenge(response: Response): boolean {
  if (response.headers.get('cf-mitigated')) return true;
  const type = response.headers.get('content-type') ?? '';
  return response.status === 403 && type.includes('text/html');
}

/** Path words kept verbatim when masking a URL. Everything else is a secret. */
const STRUCTURAL_SEGMENTS = new Set(['export', 'exports', 'download', 'downloads', 'file', 'files', 'api', 'v1', 'v2']);

/** Hosts DAMC will fetch an export package from. Exact match or a subdomain of. */
export function allowedHosts(): string[] {
  return env.DAMC_CLAUDE_DOWNLOAD_HOSTS.split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
}

function hostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return allowedHosts().some(allowed => host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * An export_url is a bearer credential: whoever has it can download the export
 * once. Keep the origin and the shape, drop everything that authenticates.
 */
export function maskUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const segments = url.pathname.split('/').filter(Boolean);
    // Default to masking, and keep only a fixed set of structural path words.
    // Heuristics went the wrong way here: masking "anything long" leaks a short
    // token, and masking "anything non-alphabetic" leaks a token that happens to
    // be letters. The shape of the URL is worth keeping in a log; nothing else is.
    const masked = segments.map(segment => (STRUCTURAL_SEGMENTS.has(segment.toLowerCase()) ? segment : '…'));
    return `${url.origin}/${masked.join('/')}${url.search ? '?…' : ''}`;
  } catch {
    return '(unparseable url)';
  }
}

/**
 * Reject anything DAMC must not fetch, before any connection is made.
 * Returns the parsed URL so the caller does not parse it twice.
 */
export async function assertDownloadableUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('DOWNLOAD_URL_INVALID', 'The manifest contains a download URL that is not a valid URL.', 400);
  }

  if (url.protocol !== 'https:') {
    throw new AppError('DOWNLOAD_URL_REJECTED',
      `Only https download URLs are accepted; the manifest asked for "${url.protocol.replace(':', '')}".`, 400);
  }
  if (url.username || url.password) {
    throw new AppError('DOWNLOAD_URL_REJECTED', 'Download URLs with embedded credentials are refused.', 400);
  }
  if (!hostAllowed(url.hostname)) {
    throw new AppError('DOWNLOAD_URL_REJECTED',
      `DAMC only downloads Claude exports from ${allowedHosts().join(', ')}; the manifest pointed at "${url.hostname}".`, 400);
  }

  // An allowlisted name that resolves inside the network is still an internal
  // request. Every resolved address must be public.
  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(url.hostname, { all: true });
  } catch {
    throw new AppError('DOWNLOAD_URL_UNRESOLVABLE', `Could not resolve "${url.hostname}".`, 502);
  }
  const privateHit = addresses.find(entry => isPrivateAddress(entry.address));
  if (privateHit) {
    throw new AppError('DOWNLOAD_URL_REJECTED',
      `"${url.hostname}" resolves to a private address (${privateHit.address}); DAMC will not fetch it.`, 400);
  }
  return url;
}

export interface DownloadResult {
  path: string;
  bytes: number;
  /** Final URL after redirects, masked — safe to log and to store on the job. */
  finalUrl: string;
  redirects: number;
}

export interface DownloadOptions {
  /** Cap on bytes written. Defaults to the shared import upload limit. */
  maxBytes?: number;
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Stream one export package to `targetPath`.
 *
 * The response body is piped to disk and never buffered, so a multi-gigabyte
 * category costs one file handle rather than its own size in memory — the same
 * rule the upload path follows.
 *
 * A failed download deletes its partial file: a half-written ZIP that survived
 * would look resumable, and with a single-use URL it can never be completed.
 */
export async function downloadExportPackage(rawUrl: string, targetPath: string, options: DownloadOptions = {}): Promise<DownloadResult> {
  const maxBytes = options.maxBytes ?? env.DAMC_IMPORT_MAX_FILE_SIZE_BYTES;
  const timeoutMs = options.timeoutMs ?? env.DAMC_CLAUDE_DOWNLOAD_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;

  let current = await assertDownloadableUrl(rawUrl);
  let redirects = 0;
  let response: Response;

  // Redirects are followed by hand so each destination is re-validated. With
  // `redirect: 'follow'` the runtime would chase a Location into the private
  // network before this module ever saw it.
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      response = await doFetch(current.toString(), { redirect: 'manual', signal: controller.signal });
    } catch (error) {
      throw new AppError('DOWNLOAD_FAILED',
        `Could not reach ${maskUrl(current.toString())}: ${error instanceof Error ? error.message : 'network error'}`, 502);
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new AppError('DOWNLOAD_FAILED', `Redirect from ${maskUrl(current.toString())} had no Location header.`, 502);
      }
      if (++redirects > MAX_REDIRECTS) {
        throw new AppError('DOWNLOAD_FAILED', `Too many redirects downloading ${maskUrl(rawUrl)}.`, 502);
      }
      current = await assertDownloadableUrl(new URL(location, current).toString());
      continue;
    }
    break;
  }

  // A bot challenge is not a spent link, and telling the user to make a new
  // export when the real obstacle is Cloudflare sends them round a loop that
  // never ends. Verified against the live endpoint: claude.ai answers a
  // server-side client with an interstitial — sometimes 403, sometimes 200 with
  // HTML — carrying `cf-mitigated: challenge`.
  if (isBotChallenge(response)) {
    throw new AppError('DOWNLOAD_BLOCKED_BY_CHALLENGE',
      'Claude answered with a bot-protection challenge instead of the export file, so DAMC cannot fetch it automatically. Download the packages from your browser and import the ZIP files directly.',
      502, { status: response.status });
  }
  if (response.status === 403 || response.status === 404 || response.status === 410) {
    // The single-use URL has been spent, or the export expired. The one failure
    // a retry cannot fix, so it gets its own code and its own instruction.
    throw new AppError('DOWNLOAD_URL_CONSUMED',
      'This Claude download link has already been used or has expired. Create a new export in Claude and upload the new manifest.',
      409, { status: response.status });
  }
  if (!response.ok) {
    throw new AppError('DOWNLOAD_FAILED', `Claude returned HTTP ${response.status} for ${maskUrl(current.toString())}.`, 502);
  }
  if (!response.body) {
    throw new AppError('DOWNLOAD_FAILED', `Claude returned an empty response for ${maskUrl(current.toString())}.`, 502);
  }

  // Trust the counter, not Content-Length: a hostile or wrong header must not
  // decide how much is written.
  let written = 0;
  const counted = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      written += chunk.byteLength;
      if (written > maxBytes) {
        controller.error(new AppError('DOWNLOAD_TOO_LARGE',
          `The Claude export package exceeds the ${maxBytes}-byte download limit.`, 413));
        return;
      }
      controller.enqueue(chunk);
    }
  });

  try {
    await pipeline(Readable.fromWeb(response.body.pipeThrough(counted) as never), createWriteStream(targetPath));
  } catch (error) {
    await fs.rm(targetPath, { force: true }).catch(() => { /* swept later */ });
    if (error instanceof AppError) throw error;
    throw new AppError('DOWNLOAD_FAILED',
      `Download of ${maskUrl(current.toString())} failed: ${error instanceof Error ? error.message : 'stream error'}`, 502);
  }

  if (written === 0) {
    await fs.rm(targetPath, { force: true }).catch(() => { /* swept later */ });
    throw new AppError('DOWNLOAD_FAILED', `Claude returned an empty file for ${maskUrl(current.toString())}.`, 502);
  }

  // What arrived has to actually be an archive. The live endpoint returns a
  // challenge page with HTTP 200, so status alone is not evidence of success —
  // without this check DAMC would store 5 KB of HTML as an export package and
  // fail later with something unrecognisable.
  const head = await readHead(targetPath, 4);
  if (!looksLikeZip(head)) {
    await fs.rm(targetPath, { force: true }).catch(() => { /* swept later */ });
    const asText = head.toString('utf8').trim().slice(0, 4).toLowerCase();
    const html = asText.startsWith('<') || (response.headers.get('content-type') ?? '').includes('text/html');
    throw new AppError(html ? 'DOWNLOAD_BLOCKED_BY_CHALLENGE' : 'DOWNLOAD_NOT_AN_ARCHIVE',
      html
        ? 'Claude returned a web page instead of the export file — this is its bot-protection challenge. Download the packages from your browser and import the ZIP files directly.'
        : `The download from ${maskUrl(current.toString())} is not a ZIP archive.`,
      502);
  }

  return { path: targetPath, bytes: written, finalUrl: maskUrl(current.toString()), redirects };
}
