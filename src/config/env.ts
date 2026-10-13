import { z } from 'zod';

/**
 * Environment booleans must be read from strings.
 * `z.coerce.boolean()` cannot be used here: it applies JavaScript truthiness, so the
 * string "false" coerces to `true`. That silently left DAMC_DEV_MODE enabled for any
 * deployment that set DAMC_DEV_MODE=false, including docker-compose.
 */
const envBool = (defaultValue: boolean) =>
  z.preprocess(value => {
    if (typeof value === 'boolean') return value;
    if (value === undefined) return defaultValue;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false;
    return value;
  }, z.boolean());

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().url().default('postgresql://damc:damc@localhost:5432/damc'),
  DATA_DIR: z.string().default('./storage'),
  GITHUB_BACKUP_REPO: z.string().optional().or(z.literal('')),
  GITHUB_BACKUP_BRANCH: z.string().default('main'),
  GITHUB_BACKUP_REMOTE: z.string().default('origin'),
  GITHUB_BACKUP_ENABLED: envBool(false),
  OBSIDIAN_VAULT_PATH: z.string().optional().or(z.literal('')),
  // Keywords that file an imported conversation under a project of that name, and
  // promote its prose from HISTORY to KNOWLEDGE. Comma-separated; empty disables the
  // behaviour entirely.
  //
  // This exists because the list used to be hardcoded to the developer's own project
  // names, so a shipped copy would create projects named after a stranger's work in
  // the user's database. It defaults to DAMC's own name only — nothing personal is
  // compiled in, and an operator can set their own list without a rebuild.
  DAMC_PROJECT_HINTS: z.string().default('damc'),

  DAMC_DEV_MODE: envBool(true),
  DAMC_API_KEY_ADMIN: z.string().optional().or(z.literal('')),

  // ---------------------------------------------------------------------------
  // Large import limits.
  //
  // A provider export is the biggest thing DAMC ingests — a real ChatGPT export
  // runs to gigabytes, most of it attached media. The upload is streamed to a
  // temp file and the conversations are read one at a time, so these caps exist
  // to bound disk and to reject hostile archives, not to bound memory.
  // ---------------------------------------------------------------------------

  // Largest upload accepted by /v1/import/:provider/file and /preview. Enforced
  // by @fastify/multipart and reported on /health so the dashboard can name the
  // real number. 4 GiB by default.
  //
  // This MUST be passed to the plugin explicitly: when limits.fileSize is
  // omitted @fastify/multipart substitutes fastify.initialConfig.bodyLimit,
  // which is 1 MB — "no limit configured" would mean a 1 MB ceiling.
  DAMC_IMPORT_MAX_FILE_SIZE_BYTES: z.coerce.number().int().positive().default(4 * 1024 * 1024 * 1024),

  // Cap on bytes written while extracting one entry out of an uploaded ZIP.
  // A ZIP declares its own sizes and a hostile one lies, so this is enforced
  // against bytes actually decompressed.
  DAMC_IMPORT_MAX_UNCOMPRESSED_BYTES: z.coerce.number().int().positive().default(8 * 1024 * 1024 * 1024),

  // ZIP-bomb guard: refuse an entry whose decompressed size exceeds its
  // compressed size by more than this factor. JSON text compresses roughly
  // 5-15x, so 200 leaves a wide margin for legitimate exports while stopping
  // the classic highly-repetitive bomb.
  DAMC_IMPORT_MAX_COMPRESSION_RATIO: z.coerce.number().int().positive().default(200),

  // Conversations ingested per batch. Bounds peak memory during an import and
  // sets how often progress is written to the job row.
  DAMC_IMPORT_BATCH_SIZE: z.coerce.number().int().positive().max(1000).default(25),

  // ---------------------------------------------------------------------------
  // Claude export manifest download.
  //
  // A Claude manifest lists category ZIPs behind single-use URLs, and DAMC
  // fetches them server-side. Because those URLs come from a file the user
  // uploaded, fetching them is a server-side request forgery primitive unless the
  // destination is constrained — this allowlist is that constraint, applied to
  // every redirect hop as well as the first request.
  // ---------------------------------------------------------------------------

  // Hosts DAMC will download a Claude export from. Comma-separated; a value
  // matches the host itself or any subdomain of it. Widen this only after
  // observing where a real Claude download actually redirects.
  DAMC_CLAUDE_DOWNLOAD_HOSTS: z.string().default('claude.ai'),
  // Per-request timeout for each category download.
  DAMC_CLAUDE_DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),

  // Where upload temp files are written. Empty means <DATA_DIR>/tmp, which keeps
  // multi-gigabyte uploads on the same volume as the rest of DAMC's storage
  // rather than on whatever the OS temp directory happens to be mounted on.
  DAMC_IMPORT_TEMP_DIR: z.string().optional().or(z.literal('')),
  // Cross-origin browser access to the API. Empty (the default) means
  // same-origin only: the bundled dashboard is served by this same server and
  // needs no CORS grant, so nothing legitimate is lost, and a page on any other
  // site cannot read /v1 from a visitor's browser. A comma-separated origin list
  // allows named web apps; "*" allows every origin and is only defensible on a
  // deployment that requires an API key for every request.
  //
  // This was previously declared and then ignored — server.ts hard-coded
  // `origin: true`, which reflects whatever Origin the caller sends — so the
  // setting had no effect at all.
  CORS_ORIGIN: z.string().default(''),
  // Local watch-folder import. Off by default: the server never watches the
  // filesystem in the background unless an operator turns it on, either once
  // from Settings/Import (in-process, until the server restarts) or for every
  // boot via this flag.
  //
  // DAMC_IMPORT_WATCH_DIR is the path Node actually reads/writes. Outside
  // Docker that is the real Windows folder. Inside Docker (the normal way
  // DAMC runs) the container can only see C:\DAMC_IMPORT if docker-compose
  // bind-mounts it in, and the path Node sees on the container side is
  // whatever that mount target is (docker-compose.yml sets both this and the
  // mount to /damc-import) — never the host path itself.
  //
  // C: rather than D: on purpose: not every Windows machine has a D: drive,
  // and creating a folder at the root of C: (unlike C:\Program Files) needs
  // no elevation — verified directly, not assumed. This is also how other
  // "drop files here and they sync" products place their folder (Dropbox,
  // OneDrive: under the user's own profile, never under Program Files).
  DAMC_IMPORT_WATCH_DIR: z.string().default('C:\\DAMC_IMPORT'),
  // Cosmetic only: the Windows path to show/link to in the UI and CLI output.
  // Falls back to DAMC_IMPORT_WATCH_DIR when unset, which is correct outside
  // Docker (there is only one path). Inside Docker, docker-compose.yml sets
  // this to the real C:\DAMC_IMPORT so the operator sees the folder they can
  // actually open, not the container-internal mount path.
  DAMC_IMPORT_WATCH_HOST_DIR: z.string().optional().or(z.literal('')),
  // The Obsidian vault as the USER sees it. OBSIDIAN_VAULT_PATH is where Node writes;
  // in the shipped container that is a bind mount of a Windows folder, and this is
  // that folder's Windows path, shown on the Obsidian page so the user knows which
  // folder to open as a vault. Cosmetic, exactly like DAMC_IMPORT_WATCH_HOST_DIR.
  DAMC_OBSIDIAN_HOST_DIR: z.string().optional().or(z.literal('')),
  DAMC_IMPORT_WATCH_AUTOSTART: envBool(false),
  // Public HTTPS origin of the remote MCP gateway, e.g. https://damc.example.com.
  // Purely cosmetic wiring for generated connection configs: when unset the
  // dashboard substitutes its own origin, which is right for tunneled setups
  // that forward the same origin, and wrong for split origins — set this when
  // the gateway is published under a different host than the dashboard.
  DAMC_PUBLIC_URL: z.string().url().optional().or(z.literal('')),
  // Remote gateway rate limit, per API key per minute. Local /v1 is not
  // throttled — this protects the published endpoint only.
  DAMC_MCP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().max(10000).default(120),
  // Explicit path to the cloudflared binary for the managed Remote Access
  // tunnel. Unset means: look for cloudflared on PATH.
  DAMC_CLOUDFLARED_PATH: z.string().optional().or(z.literal('')),
  // Named (persistent) Cloudflare tunnel. When set, Remote Access runs
  // `cloudflared tunnel run` with this token (passed via the child process
  // environment, never via argv, logs, or API responses) instead of an
  // ephemeral quick tunnel — the public hostname stays stable across restarts.
  // Create one with `cloudflared tunnel login` + `cloudflared tunnel create`,
  // then route DAMC_TUNNEL_HOSTNAME to it in the Cloudflare dashboard.
  DAMC_TUNNEL_TOKEN: z.string().optional().or(z.literal('')),
  // Public hostname served by the named tunnel above, e.g. memory.example.com
  // (scheme optional). Only used to advertise the endpoint; the tunnel itself
  // is configured in Cloudflare, not here.
  DAMC_TUNNEL_HOSTNAME: z.string().optional().or(z.literal(''))
});

export const env = schema.parse(process.env);
