/**
 * The invariants a shipped DAMC has to hold, and that nothing else in the suite
 * could fail on.
 *
 * Before this file, a 727-test green run said nothing about whether the product
 * ships sample data, whether /health leaks a secret, or whether the configuration
 * the installer copies onto a user's machine runs in dev mode. Every one of those
 * was checked by hand and then re-recorded in prose — so each could be reintroduced
 * silently by the next change, and one of them had been: the developer's own
 * project names were compiled into the import path, where they created projects in
 * a stranger's database.
 *
 * These are cheap on purpose. Three of the four need no database and no server.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => fs.readFile(path.join(root, relative), 'utf8');

// ---------------------------------------------------------------------------

describe('the product ships no sample data', () => {
  it('keeps every demo dataset empty', async () => {
    // web/demo-data.js is allowed to exist — the user's own rule is that the file
    // may ship, not that it may contain content. It shipped "DAMC" and "Earthus"
    // sample projects once; an empty dataset cannot be mistaken for real memory.
    const demo = await import('../web/demo-data.js') as Record<string, unknown>;
    for (const [name, value] of Object.entries(demo)) {
      if (Array.isArray(value) && /^demo(Projects|Memories|Relations|SyncJobs|McpActivity)$/.test(name)) {
        expect(value, name).toEqual([]);
      }
    }
    const dashboard = demo.demoDashboard as Record<string, unknown>;
    for (const [key, value] of Object.entries(dashboard ?? {})) {
      if (typeof value === 'number') expect(value, `demoDashboard.${key}`).toBe(0);
    }
    const state = typeof demo.demoState === 'function' ? (demo.demoState as () => Record<string, unknown>)() : {};
    for (const [key, value] of Object.entries(state)) {
      if (Array.isArray(value)) expect(value, `demoState().${key}`).toEqual([]);
    }
    const graph = typeof demo.demoGraph === 'function' ? (demo.demoGraph as () => { nodes: unknown[]; edges: unknown[] })() : { nodes: [], edges: [] };
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });

  it('enters sample mode only when it is asked to', async () => {
    // The regression this pins: demo mode used to be the fallback for ANY failed
    // health probe — a slow container on a fresh install, one tunnel timeout — and
    // in that state every read came from the sample dataset while the page looked
    // like an ordinary dashboard. "Your database" and "a stand-in for it" must not
    // be the same screen, and the product must never make that swap on its own.
    const api = await read('web/api.js');
    expect(api).toContain("export function isDemo() { return connection.mode === 'demo'; }");
    expect(api).not.toContain("connection.mode = 'demo';\n    connection.health = null;\n    connection.reason = error");
    // A failed probe reports being offline, which is a different thing.
    expect(api).toContain("connection.mode = 'offline';");
  });

  it('compiles no personal project name into the import path', async () => {
    // detectProjectHint creates a real `projects` row from a keyword match. The
    // keywords used to be three of the developer's own project names plus a test
    // string, so importing a conversation that mentioned any of them filed the
    // user's memories under a stranger's project.
    const ingestion = await read('src/services/ingestion-service.ts');
    expect(ingestion).toContain('env.DAMC_PROJECT_HINTS');
    for (const name of ['snapn', 'discard me']) {
      expect(ingestion.toLowerCase(), name).not.toContain(name);
    }
    const { env } = await import('../src/config/env.js');
    // The shipped default names nothing but DAMC itself.
    expect(env.DAMC_PROJECT_HINTS).toBe('damc');
  });

  it('no longer carries a database seeder', async () => {
    // scripts/seed.ts inserted a project and a conversation, and tsconfig compiled
    // every script into dist — so the seeder rode along inside the production image,
    // one copy-paste away from the line damc-start.cmd already runs against the
    // user's live volume (`node dist/scripts/migrate.js`).
    await expect(fs.stat(path.join(root, 'scripts/seed.ts'))).rejects.toBeDefined();
    const pkg = JSON.parse(await read('package.json'));
    expect(Object.keys(pkg.scripts)).not.toContain('db:seed');
    const tsconfig = await read('tsconfig.json');
    expect(tsconfig).not.toContain('scripts/**/*.ts');
    expect(tsconfig).toContain('scripts/migrate.ts');
  });

  it('applies migrations that only create schema', async () => {
    const names = (await fs.readdir(path.join(root, 'migrations'))).filter(n => n.endsWith('.sql')).sort();
    expect(names.length).toBeGreaterThanOrEqual(7);
    for (const name of names) {
      const sql = await read(`migrations/${name}`);
      // A migration that inserts rows would put data in every install that ever
      // runs it, with no way for the user to have consented to it.
      expect(sql, name).not.toMatch(/\bINSERT\s+INTO\b/i);
      expect(sql, name).not.toMatch(/\bCOPY\s+\w+\s+FROM\b/i);
    }
  });
});

describe('the shipped configuration', () => {
  it('does not run the product in dev mode', async () => {
    // The file the installer copies to the install directory as the production
    // configuration. Nothing read it before, so nothing would have caught a change.
    const compose = await read('release/payload/docker-compose.yml');
    expect(compose).toMatch(/DAMC_DEV_MODE:\s*"false"/);
    expect(compose).not.toMatch(/DAMC_DEV_MODE:\s*"true"/);
  });

  it('publishes only loopback ports', async () => {
    const compose = await read('release/payload/docker-compose.yml');
    const published = [...compose.matchAll(/ports:\s*\["([^"]+)"\]/g)].map(m => m[1]!);
    // One now: the app. The database is not published at all.
    expect(published.length).toBeGreaterThanOrEqual(1);
    for (const binding of published) {
      // DAMC is a local single-user store. A published 0.0.0.0 port would put the
      // whole memory database on the LAN.
      expect(binding, binding).toMatch(/^127\.0\.0\.1:/);
    }
  });

  it('ships no secret in the configuration the installer writes', async () => {
    const compose = await read('release/payload/docker-compose.yml');
    // The Postgres password is a fixed local default and that is deliberate — the
    // port is loopback-only and the database is single-user. What must not be here
    // is a tunnel token, an admin key or a GitHub credential.
    for (const forbidden of ['DAMC_TUNNEL_TOKEN', 'DAMC_API_KEY_ADMIN', 'GITHUB_TOKEN', 'GH_TOKEN']) {
      expect(compose, forbidden).not.toContain(forbidden);
    }
  });

  it('loads the shipped image when it is missing or changed, so an upgrade is never a no-op', async () => {
    // Two failure modes bracket this rule. The start script once loaded the tar on
    // every start — 200 MB and ~20 s each time, shown to the user in a console. And
    // before that it skipped the load whenever a tag of the same name existed; the
    // tag is not build-unique, so upgrading over an earlier 1.2.0 silently kept the
    // old image. The rule now: load if `docker image inspect` fails, OR if the tar's
    // size+mtime differs from the marker written after the last successful load.
    const start = await read('release/payload/scripts/damc-start.cmd');
    expect(start).toMatch(/docker image inspect %IMAGE%/);
    expect(start).toMatch(/images-loaded\.txt/);
    expect(start).toMatch(/set "SIG=%%~zf %%~tf"/);
    expect(start).toMatch(/if "%LASTSIG%"=="%SIG%" goto :loaded/);
    expect(start).toMatch(/docker load -i "%TAR%"/);
    // The marker is written only after a load that succeeded.
    expect(start).toMatch(/docker load -i "%TAR%"[\s\S]{0,200}exit \/b 4[\s\S]{0,60}>"%MARK%" echo %SIG%/);
  });
});

describe('/health', () => {
  it('reports the auth posture and nothing secret', async () => {
    const routes = await read('src/http/routes.ts');
    const handler = routes.slice(routes.indexOf("app.get('/health'"), routes.indexOf("app.get('/v1/dashboard'"));
    // The contract other code reads. `devMode` keeps its name and meaning; `auth`
    // is additive, and is what lets a first-run dashboard tell "you need a key"
    // from "your key is wrong".
    for (const field of ['ok:', 'service:', 'version:', 'devMode:', 'auth:', 'limits:', 'time:']) {
      expect(handler, field).toContain(field);
    }
    expect(handler).toContain('required: !env.DAMC_DEV_MODE');
    expect(handler).toContain('bootstrapped:');
    // Every env var that holds a credential, checked by name against the handler.
    for (const secret of ['DATABASE_URL', 'DAMC_API_KEY_ADMIN', 'DAMC_TUNNEL_TOKEN', 'GITHUB_BACKUP_REPO']) {
      expect(handler, secret).not.toContain(secret);
    }
  });

  it('gates an unauthenticated key request on the request originating here', async () => {
    const auth = await read('src/http/auth.ts');
    const gate = auth.slice(auth.indexOf('export async function mayBootstrap'),
      auth.indexOf('export async function mayBootstrap') + 400);
    // Locality is the whole gate, and it is the half that matters: the same
    // forwarding-header test dev mode used, so a proxy or tunnel can never reach it.
    expect(gate).toContain('isLocalRequest(request)');
    // Deliberately NOT also gated on "no key exists yet". That gate locked the owner
    // out permanently once they cleared their browser storage — keys are hashed, so
    // there was nothing to recover — while stopping nothing a hostile local process
    // could not do by reading the stored key off disk.
    expect(gate).not.toContain('hasLiveApiKey()');
    // hasLiveApiKey still exists, for /health's `bootstrapped` field.
    expect(auth).toContain('export async function hasLiveApiKey');
    expect(auth).toContain('revoked_at IS NULL');
  });

  it('does not publish the database to the host', async () => {
    // With 127.0.0.1:5432 published and the fixed password in the same file, any
    // local process could read the user's whole memory database directly — which
    // made the API's own authentication decorative. Nothing on the host needs the
    // port: the app reaches `db` over the compose network.
    const compose = await read('release/payload/docker-compose.yml');
    expect(compose).not.toMatch(/ports:\s*\["127\.0\.0\.1:5432/);
    expect(compose).toMatch(/POSTGRES_PASSWORD/);
  });
});

describe('the session plan endpoints refuse a download URL', () => {
  it('declares both plan schemas strict', async () => {
    // Found by posting a plan that carried export_url to the installed product: zod
    // strips unknown keys by default, so the request succeeded with a 201 and the
    // documented refusal in planFromEntries was unreachable — the field had already
    // been dropped. Nothing leaked, but "this endpoint refuses URLs" was not true.
    const routes = await read('src/http/routes.ts');
    const plan = routes.slice(
      routes.indexOf("app.post('/v1/import/claude/manifest/plan/preview'"),
      routes.indexOf("app.post('/v1/import/claude/manifest', "));
    // Two strict() calls per schema: the entry object and the envelope.
    expect((plan.match(/\.strict\(\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
