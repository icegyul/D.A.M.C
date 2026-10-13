import { query } from '../db/pool.js';
import { createApiKey } from './api-key-service.js';
import { findOrCreateProject } from './project-service.js';
import { LOCAL_OWNER, ensureLocalOwner } from '../http/auth.js';

/**
 * Issue the first API key.
 *
 * Two ways in, and they are different things.
 *
 * ADMIN-KEY BOOTSTRAP creates a *new* user and is how a multi-user or server
 * deployment provisions accounts. It needs DAMC_API_KEY_ADMIN configured and
 * presented, and it stays available for as long as that key is set.
 *
 * LOCAL BOOTSTRAP hands a key to the person sitting at the machine and adopts the
 * existing local owner rather than creating a second user — so the watch folder,
 * Remote Access and the dashboard all act as the same identity. The caller decides
 * whether the conditions hold (see auth.mayBootstrap: the request must originate on
 * this machine); this function will not invent that permission for itself. The key
 * is labelled `local-dashboard` so the owner can tell it apart on the Connections
 * page and revoke it.
 *
 * This path exists so the product can ship with authentication enforced. Without
 * it, DAMC_DEV_MODE=false produced an install with no way to obtain a credential
 * that did not involve a terminal.
 */
export async function bootstrapUser(
  adminKey: string | undefined,
  expectedAdminKey: string | undefined,
  input: { email?: string; displayName?: string; projectName?: string },
  options: { firstRun?: boolean } = {}
) {
  const adminAuthorised = Boolean(expectedAdminKey) && Boolean(adminKey) && adminKey === expectedAdminKey;
  if (!adminAuthorised && !options.firstRun) throw new Error('Invalid bootstrap key');

  // First run adopts the local owner. Creating another user here would split the
  // install in two: boot tasks act as the local owner, the dashboard as whoever
  // this returned.
  if (!adminAuthorised) {
    await ensureLocalOwner();
    const key = await createApiKey(LOCAL_OWNER, 'local-dashboard');
    return { userId: LOCAL_OWNER, firstRun: true, ...key };
  }

  const email = input.email?.trim() || null;
  const displayName = input.displayName?.trim() || 'DAMC User';
  const existing = email
    ? await query<{ id: string }>(`SELECT id FROM users WHERE email=$1 LIMIT 1`, [email])
    : { rows: [] as Array<{ id: string }> };
  const userId = existing.rows[0]?.id
    ?? (await query<{ id: string }>(`INSERT INTO users(email,display_name) VALUES($1,$2) RETURNING id`, [email, displayName])).rows[0]!.id;
  if (input.projectName?.trim()) await findOrCreateProject(userId, input.projectName);
  const key = await createApiKey(userId, 'initial');
  return { userId, firstRun: false, ...key };
}
