import type { FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { resolveApiKey } from '../services/api-key-service.js';
import { isPrivateAddress } from '../lib/ip.js';

/**
 * The local owner of a single-user install.
 *
 * Named DEMO_USER for historical reasons and kept under that name because callers
 * and tests import it; it is not a demo account and carries no sample data. It is
 * the id every table's foreign key points at on a machine where one person owns
 * the whole database.
 */
export const DEMO_USER = '00000000-0000-0000-0000-000000000001';
/** The same id under the name that describes it. Prefer this in new code. */
export const LOCAL_OWNER = DEMO_USER;

/**
 * Make sure the local owner row exists.
 *
 * Runs whatever the auth mode is, which is the point. It used to return early
 * unless dev mode was on — so turning dev mode off produced an install whose boot
 * tasks (watch folder, Remote Access) wrote against a user id that did not exist,
 * and every one of them failed on the users(id) foreign key with nothing on screen
 * to explain it.
 *
 * One row, no email harvesting, no project, no content. A no-op on an existing
 * database.
 */
export async function ensureLocalOwner(): Promise<void> {
  await query(
    `INSERT INTO users(id, email, display_name) VALUES($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [LOCAL_OWNER, 'local@damc.local', 'DAMC Local User']
  );
}

/** Kept for callers that still use the old name. */
export const ensureDevUser = ensureLocalOwner;

/**
 * Has anyone been issued an API key yet?
 *
 * This is the whole gate on first-run bootstrap: the moment one live key exists,
 * DAMC stops handing them out for free. Counting revoked keys would be wrong —
 * revoking your only key has to leave you a way back in.
 */
export async function hasLiveApiKey(): Promise<boolean> {
  const result = await query<{ one: number }>(
    `SELECT 1 AS one FROM api_keys WHERE revoked_at IS NULL LIMIT 1`
  );
  return result.rows.length > 0;
}

/**
 * May this request claim an API key without presenting one?
 *
 * One condition, and it is the load-bearing one: the request must originate on this
 * machine. That is the same test dev mode used — forwarding headers disqualify a
 * request, so a proxy, a load balancer or DAMC's own Remote Access tunnel can never
 * reach this, whatever the socket says.
 *
 * IT IS DELIBERATELY NOT GATED ON "no key exists yet". That gate was tried and
 * removed, for two reasons found by installing the product and using it:
 *
 *   It locked the owner out permanently. Keys are stored hashed, so a user who
 *   cleared their browser storage, switched browsers, or opened the dashboard in a
 *   second profile had nothing to recover and no way back in that did not involve a
 *   terminal — which is exactly what this product promises not to require.
 *
 *   It was not buying the security it appeared to. The threat it addressed is a
 *   hostile process on this machine, and such a process can read the dashboard's
 *   stored key off disk anyway. It could also, until the same change closed it, open
 *   the published PostgreSQL port with the fixed password shipped in the compose
 *   file and read the whole memory database directly. A gate that stops none of that
 *   while breaking legitimate recovery is not a trade worth making.
 *
 * What replaces it is attribution rather than a narrower window: every key issued
 * this way is labelled and listed on the Connections page with its creation and
 * last-used time, so the owner can see what holds access and revoke it. Compared
 * with the dev mode this supersedes, the same callers can get in, but they can no
 * longer act anonymously, cannot claim an arbitrary identity through
 * `X-DAMC-User-Id`, and can be revoked.
 */
export async function mayBootstrap(request: Parameters<typeof isLocalRequest>[0]): Promise<boolean> {
  return isLocalRequest(request);
}

/**
 * Headers that mean "this request reached DAMC through something else". Every
 * proxy, tunnel and load balancer adds at least one of them, so their presence —
 * not the socket address — is the reliable evidence that a request came from
 * somewhere other than this machine.
 *
 * The socket address cannot carry that weight, and in the normal Docker
 * deployment it points the wrong way entirely. DAMC spawns cloudflared as its own
 * child process inside the container, so tunnelled traffic from the internet
 * reaches the server from 127.0.0.1, while the operator's own dashboard arrives
 * from the bridge gateway (172.x). Trusting loopback would have trusted exactly
 * the traffic that must not be trusted, and rejected the traffic that must be.
 */
const FORWARDING_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'forwarded',
  'cf-connecting-ip',
  'cf-ray'
] as const;

/**
 * Did this request originate on the machine DAMC runs on?
 *
 * Read from the raw socket, never `request.ip`: `request.ip` becomes
 * header-derived once Fastify's `trustProxy` is enabled, and a credential
 * decision must not depend on a value the caller controls.
 *
 * Private ranges count as local because that is how a containerised DAMC is
 * reached: Docker NATs the host's connection to the bridge gateway, so a request
 * from the operator's own browser genuinely arrives from 172.x. The limit of
 * this: a LAN peer is indistinguishable from the Docker host at the socket
 * level, so a deployment that publishes beyond loopback should set
 * DAMC_DEV_MODE=false. See lib/ip.ts for the classifier itself.
 */
export function isLocalRequest(request: Pick<FastifyRequest, 'headers'> & { socket?: { remoteAddress?: string | undefined } }): boolean {
  for (const header of FORWARDING_HEADERS) {
    if (request.headers[header] !== undefined) return false;
  }
  const address = request.socket?.remoteAddress;
  if (!address) return false;
  return isPrivateAddress(address);
}

/**
 * Resolve the user a request acts as.
 *
 * A valid `Authorization: Bearer damc_…` key always wins and works from
 * anywhere. Dev mode is the fallback, and it is deliberately scoped to loopback:
 * DAMC_DEV_MODE exists so the bundled dashboard works on a fresh local install
 * with no key to paste, and that convenience has no remote equivalent.
 *
 * Before this was enforced, dev mode (the docker-compose default) plus Remote
 * Access published every /v1 route to the internet with no credential — and
 * `X-DAMC-User-Id`, which names any user id the caller likes, with it. The docs
 * said to set DAMC_DEV_MODE=false before exposing DAMC; nothing made it true.
 * Locality is checked per request instead, so the unsafe combination cannot be
 * reached by forgetting a flag.
 */
export async function authenticate(request: FastifyRequest) {
  const auth = request.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const userId = await resolveApiKey(auth.slice(7).trim());
    if (userId) return userId;
    throw new Error('Invalid API key');
  }
  if (env.DAMC_DEV_MODE && isLocalRequest(request)) {
    const headerUser = request.headers['x-damc-user-id'];
    if (typeof headerUser === 'string') return headerUser;
    return DEMO_USER;
  }
  if (env.DAMC_DEV_MODE) {
    throw new Error('Authentication required: dev mode only applies to requests from this machine. Pass a DAMC API key as `Authorization: Bearer damc_…`.');
  }
  throw new Error('Authentication required');
}
