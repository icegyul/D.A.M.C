/**
 * Address classification, shared by the two places that must not confuse a
 * private address for a public one.
 *
 * Extracted from http/auth.ts, which uses it to decide whether a request came
 * from this machine. services/claude-download-service.ts uses the same predicate
 * for the opposite purpose: refusing to fetch a URL that resolves into the
 * private network. One implementation, so the two cannot disagree about what
 * "private" means.
 */

/** Loopback, RFC1918 private, link-local, and IPv6 unique-local. */
export function isPrivateAddress(raw: string): boolean {
  if (!raw) return false;
  // Strip an IPv6 zone index ("fe80::1%eth0").
  const address = raw.split('%')[0]!.trim().toLowerCase();
  // An IPv4-mapped IPv6 address is an IPv4 address.
  const candidate = address.startsWith('::ffff:') ? address.slice(7) : address;

  const octets = candidate.split('.');
  if (octets.length === 4) {
    if (octets.some(o => o === '' || !/^\d{1,3}$/.test(o))) return false;
    const parts = octets.map(Number);
    if (parts.some(n => n > 255)) return false;
    const [a, b] = parts as [number, number, number, number];
    if (a === 127) return true;                        // 127.0.0.0/8 loopback
    if (a === 10) return true;                          // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12 (Docker bridge)
    if (a === 192 && b === 168) return true;            // 192.168.0.0/16
    if (a === 169 && b === 254) return true;            // 169.254.0.0/16 link-local
    if (a === 0) return true;                           // 0.0.0.0/8 "this network"
    if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 CGNAT
    return false;
  }

  if (candidate === '::1' || candidate === '::') return true;   // IPv6 loopback / unspecified
  if (/^fe[89ab]/.test(candidate)) return true;                 // fe80::/10 link-local
  if (/^f[cd]/.test(candidate)) return true;                    // fc00::/7 unique-local
  return false;
}
