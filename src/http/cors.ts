/**
 * Translate CORS_ORIGIN into what @fastify/cors expects.
 *
 * Kept out of server.ts so it can be tested directly: importing server.ts binds
 * a port and starts the watch folder.
 */

/**
 * - empty  → `false`: no CORS headers at all. The bundled dashboard is served by
 *   this same server, so it is same-origin and unaffected; a page on any other
 *   site is refused by the browser. This is the default.
 * - `"*"`  → the literal `*`, not `true`. `true` *reflects* the caller's Origin,
 *   which also permits credentialed cross-origin requests; a literal `*` is one
 *   browsers refuse to use with credentials.
 * - a list → exactly those origins.
 */
export function corsOrigin(configured: string): false | '*' | string[] {
  const raw = configured.trim();
  if (!raw) return false;
  if (raw === '*') return '*';
  const origins = raw.split(',').map(o => o.trim()).filter(Boolean);
  return origins.length ? origins : false;
}
