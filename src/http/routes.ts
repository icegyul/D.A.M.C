import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestConversation } from '../services/ingestion-service.js';
import { searchMemories, buildContextPackage } from '../services/retrieval-service.js';
import { getGraph } from '../services/graph-service.js';
import { exportJson, exportObsidian, obsidianStatus } from '../services/export-service.js';
import { backupToGitHub } from '../services/github-backup-service.js';
import { listMemories, getMemoryDetail, listMemoryProviders } from '../repositories/memory-repository.js';
import { setMemoryStatus } from '../services/memory-engine.js';
import { runImportJob, runStreamingImportJob, listSyncJobs } from '../services/sync-service.js';
import { startWatcher, stopWatcher, getWatcherStatus, ensureWatchFolders } from '../services/import-watch-service.js';
import { setWatchFolderEnabled } from '../services/watch-state-service.js';
import { buildCurrentState, getStoredCurrentState } from '../services/current-state-service.js';
import { linkRelatedMemories } from '../services/relation-service.js';
import { authenticate, mayBootstrap, hasLiveApiKey } from './auth.js';
import { createApiKey, listApiKeys, revokeApiKey } from '../services/api-key-service.js';
import { getDashboard, listProjects } from '../services/dashboard-service.js';
import { findOrCreateProject } from '../services/project-service.js';
import { parseImportPackage } from '../services/import-package-service.js';
import { storeUploadToTempFile } from '../services/import-upload-service.js';
import { openExportSource, summarizeExport } from '../services/import-stream-service.js';
import { listActiveProgress, getProgress } from '../services/import-progress-service.js';
import { readManifestFile, summarizeManifest, looksLikeClaudeManifest, parseClaudeManifest, CATEGORY_PRIORITY, type ClaudeManifest } from '../services/claude-manifest-service.js';
import { startManifestImport } from '../services/claude-manifest-import-service.js';
import { startSession, getSession, openPackage, planFromEntries } from '../services/claude-package-service.js';
import { CATEGORY_DISPOSITION } from '../services/claude-category-service.js';
import { lookupDownloadAttempts, lookupByFingerprints, isSpent, fingerprintUrl } from '../repositories/claude-export-repository.js';
import { AppError } from '../errors/app-error.js';
import { bootstrapUser } from '../services/bootstrap-service.js';
import { getConnectorStatus } from '../services/connector-status-service.js';
import { connectProvider, disconnectProvider } from '../services/connector-connection-service.js';
import { buildContextPack } from '../services/context-pack-service.js';
import { enableRemoteAccess, disableRemoteAccess, getRemoteAccessState, verifyEndpoint, recordVerifyResult } from '../services/remote-access-service.js';
import { getRecentActivity } from '../services/mcp-activity-service.js';
import { handleMcpRequest, listTools, MCP_PROTOCOL_VERSION } from '../connectors/mcp/server.js';
import { registerMcpGateway } from './mcp-gateway.js';
import { env } from '../config/env.js';
import { DAMC_VERSION } from '../version.js';

const conversationSchema = z.object({
  provider: z.string().min(1), externalId: z.string().min(1), title: z.string().optional(),
  startedAt: z.string().optional(), endedAt: z.string().optional(), rawPayload: z.unknown().optional(),
  projectHint: z.string().optional(), metadata: z.record(z.string(), z.unknown()).optional(),
  messages: z.array(z.object({ externalId: z.string().optional(), role: z.enum(['system','user','assistant','tool','unknown']), content: z.string(), sequenceNo: z.number().int().nonnegative(), sentAt: z.string().optional(), metadata: z.record(z.string(), z.unknown()).optional() })).min(1)
});

const optionalUuid = (v: unknown) => (typeof v === 'string' && v.trim() ? z.string().uuid().parse(v.trim()) : undefined);
const optionalText = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const optionalNumber = (v: unknown) => { const n = Number(v); return typeof v === 'string' && v.trim() && !Number.isNaN(n) ? n : undefined; };

export async function registerRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    // The bundled dashboard is served from the same origin and must be able to load
    // its own HTML/CSS/JS before the user has supplied any credential.
    // Only the /v1 API surface is authenticated.
    if (!req.url.startsWith('/v1')) return;

    // The one exception: a request that originates on this machine may claim an API
    // key without presenting one. This is what lets DAMC ship with authentication
    // enforced instead of in dev mode — a fresh install would otherwise have no way
    // to obtain a credential that did not involve a terminal.
    //
    // Unreachable through a proxy or tunnel: mayBootstrap uses the same
    // forwarding-header test as dev mode, so anything that arrived through something
    // else is refused. See auth.mayBootstrap for why it is not additionally gated on
    // "no key exists yet" — that gate locked the owner out of their own install and
    // bought no security a local process could not get around anyway.
    if (req.method === 'POST' && req.url.startsWith('/v1/auth/bootstrap')) {
      if (await mayBootstrap(req).catch(() => false)) {
        (req as any).damcFirstRun = true;
        // Logged, because handing out a credential should never be silent. The owner
        // can also see the result on the Connections page and revoke it.
        req.log.warn({ route: '/v1/auth/bootstrap' }, 'issuing an API key to an unauthenticated local request');
        return;
      }
    }

    try { (req as any).damcUserId = await authenticate(req); }
    catch (e) { return reply.code(401).send({ error: 'UNAUTHORIZED', message: e instanceof Error ? e.message : 'Authentication required' }); }
  });
  const uid = (req: any) => req.damcUserId as string;

  // `limits` is additive: the dashboard reads named fields off this payload
  // (see web/api.js detectConnection), so it can name the real maximum upload
  // size instead of hardcoding a guess.
  /**
   * Unauthenticated by design — it is how the dashboard and any monitor find out
   * whether the backend is up at all.
   *
   * Additive only: `devMode` keeps its name and meaning (the dashboard and tests
   * read it) and is simply false in a shipped configuration. `auth` is new and says
   * what a client should DO: whether a credential is required, and whether this
   * install has one yet. Without that second fact a first-run dashboard could not
   * tell "you need a key" from "your key is wrong".
   *
   * Nothing secret goes in here. Not the database URL, not the admin key, not the
   * tunnel token, not an API key — only whether one exists.
   */
  app.get('/health', async () => ({
    ok: true, service: 'damc-backend', version: DAMC_VERSION, devMode: env.DAMC_DEV_MODE,
    auth: {
      required: !env.DAMC_DEV_MODE,
      // Whether a key has ever been issued, so the dashboard knows to offer a
      // first-run bootstrap rather than a "paste your key" box.
      bootstrapped: await hasLiveApiKey().catch(() => true)
    },
    limits: { importFileBytes: env.DAMC_IMPORT_MAX_FILE_SIZE_BYTES },
    time: new Date().toISOString()
  }));
  app.get('/v1/dashboard', async req => getDashboard(uid(req)));
  app.get('/v1/projects', async req => listProjects(uid(req)));
  app.post('/v1/projects', async (req, reply) => { const body = z.object({ name: z.string().min(1).max(120) }).parse(req.body); const id = await findOrCreateProject(uid(req), body.name); return reply.code(201).send({ id, name: body.name }); });
  app.get('/v1/connectors/capabilities', async req => getConnectorStatus(uid(req), { baseUrl: publicOrigin(req) }));
  // Connect/disconnect a provider's *local* pipeline (web upload, CLI, watch
  // folder, MCP) — not an account session. See connector-connection-service.ts.
  app.post('/v1/connectors/:provider/connect', async req => connectProvider(uid(req), z.string().min(1).parse((req.params as any).provider)));
  app.post('/v1/connectors/:provider/disconnect', async req => disconnectProvider(uid(req), z.string().min(1).parse((req.params as any).provider)));
  app.get('/v1/context/pack', async req => { const q = req.query as any; return buildContextPack(uid(req), { projectId: optionalUuid(q.projectId) }); });
  // Recent memory activity: newest-first feed of real MCP/API tool calls
  // (client, tool, outcome, time). Content-free by construction — see
  // mcp-activity-service.ts. Powers the Sync Center activity card.
  app.get('/v1/activity/mcp', async req => ({ activity: await getRecentActivity(uid(req), Number((req.query as any).limit ?? 20)) }));
  app.post('/v1/ingest/conversations', async (req, reply) => reply.send(await ingestConversation(uid(req), conversationSchema.parse(req.body))));
  app.post('/v1/import/:provider', async (req, reply) => {
    const provider = z.enum(['chatgpt','claude']).parse((req.params as any).provider);
    const body = req.body;
    return reply.send(await runImportJob(uid(req), provider, body, { source: 'web' }));
  });
  // Large-export upload. The file is streamed to a temp file and read back one
  // conversation at a time; it is never loaded into a Buffer. `toBuffer()` used
  // to sit here, which is what made a 1.9 GB export impossible.
  app.post('/v1/import/:provider/file', async (req, reply) => {
    const provider = z.enum(['chatgpt','claude']).parse((req.params as any).provider);
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'FILE_REQUIRED', message: 'Attach a JSON or ZIP export file.' });
    const upload = await storeUploadToTempFile(file);
    try {
      // A manifest is not an export: importing it means fetching five archives
      // behind single-use URLs. That must be an explicit choice, so the generic
      // import path refuses it and names the endpoint that does it — rather than
      // silently spending links the user cannot get back.
      const manifest = await readManifestFile(upload.path);
      if (manifest) {
        return reply.code(409).send({
          error: 'MANIFEST_DETECTED',
          message: 'This file is a Claude export manifest, not an export. Use the Claude export package importer so the download links are used exactly once.',
          details: summarizeManifest(manifest)
        });
      }
      const source = await openExportSource(upload.path);
      try {
        const result = await runStreamingImportJob(uid(req), provider, report => source.conversations(provider, report), { source: 'web', fileName: upload.filename, fileBytes: upload.bytes });
        return reply.send({
          ...result,
          fileName: upload.filename,
          fileBytes: upload.bytes,
          container: source.info.container,
          layout: source.info.layout,
          shardCount: source.info.shardCount,
          shardNames: source.info.shardNames,
          // Named `conversationsParsed` for compatibility with the previous
          // response shape; streaming means it is counted, not pre-parsed.
          conversationsParsed: result.conversationsDetected
        });
      } finally {
        await source.dispose();
      }
    } finally {
      // Runs on success, on a thrown error, and on a client abort.
      await upload.cleanup();
    }
  });
  // Parse-only. Nothing is written; used to show the operator what a file contains before import.
  app.post('/v1/import/:provider/preview', async (req, reply) => {
    const provider = z.enum(['chatgpt','claude']).parse((req.params as any).provider);
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'FILE_REQUIRED', message: 'Attach a JSON or ZIP export file.' });
    const upload = await storeUploadToTempFile(file);
    try {
      // Manifest detection happens here too, and this is the path that actually
      // matters for the UI: selecting a file previews it automatically, so
      // dropping the manifest in is how a user discovers DAMC can fetch the
      // packages. Reading the manifest touches no export_url — see
      // summarizeManifest.
      const manifest = await readManifestFile(upload.path);
      if (manifest) {
        const seen = await lookupDownloadAttempts(uid(req), manifest.files.map(f => f.exportUrl)).catch(() => new Map());
        const summary = summarizeManifest(manifest);
        return reply.send({
          ...summary,
          fileName: upload.filename,
          fileBytes: upload.bytes,
          categories: summary.categories.map((entry, index) => ({
            ...entry,
            disposition: CATEGORY_DISPOSITION[entry.category]?.action ?? 'retain',
            // Told before anything is fetched: a link spent by an earlier import
            // cannot work again, and the user should hear that now rather than
            // after starting a five-file download.
            alreadyUsed: isSpent(seen.get(fingerprintUrl(manifest.files[index]!.exportUrl)))
          })),
          dryRun: true
        });
      }

      let summary;
      try {
        summary = await summarizeExport(upload.path, provider);
      } catch (e) {
        // A 4xx AppError (missing conversations.json, unreadable archive,
        // oversized entry) already says exactly what is wrong — let the error
        // handler answer with its own status instead of flattening it to 400.
        if (e instanceof AppError) throw e;
        return reply.code(400).send({ error: 'PARSE_FAILED', message: e instanceof Error ? e.message : 'Could not parse export file.' });
      }
      return reply.send({
        provider, fileName: upload.filename, fileBytes: upload.bytes,
        container: summary.container, layout: summary.layout,
        shardCount: summary.shardCount, shardNames: summary.shardNames, jsonBytes: summary.jsonBytes,
        conversations: summary.conversations, messages: summary.messages,
        sampleTitles: summary.sampleTitles,
        dryRun: true
      });
    } finally {
      await upload.cleanup();
    }
  });
  // ---------------------------------------------------------------------------
  // Claude export packages.
  //
  // Claude's "Export your data" now produces a manifest listing category ZIPs
  // behind single-use URLs. These two routes are the only ones that touch those
  // URLs, and only the second one fetches anything.
  // ---------------------------------------------------------------------------

  /**
   * Describe a manifest. Reads the JSON and nothing else — previewing must never
   * consume an export_url, because using one destroys it.
   */
  app.post('/v1/import/claude/manifest/preview', async (req, reply) => {
    const manifest = await manifestFromRequest(req);
    const seen = await lookupDownloadAttempts(uid(req), manifest.files.map(f => f.exportUrl)).catch(() => new Map());
    const summary = summarizeManifest(manifest);
    return reply.send({
      ...summary,
      categories: summary.categories.map((entry, index) => ({
        ...entry,
        disposition: CATEGORY_DISPOSITION[entry.category]?.action ?? 'retain',
        alreadyUsed: isSpent(seen.get(fingerprintUrl(manifest.files[index]!.exportUrl)))
      }))
    });
  });

  /**
   * Describe a manifest the server has never seen.
   *
   * The dashboard parses the manifest locally and posts the package list plus a
   * sha256 of each download URL. That is what lets the preview say "this link was
   * already used" without the link itself ever reaching the server — the whole
   * safety property of this flow, which an upload-to-identify step would have
   * quietly broken by writing five live credentials to the data volume.
   *
   * A fingerprint is not a credential: it cannot be turned back into a URL.
   */
  app.post('/v1/import/claude/manifest/plan/preview', async (req, reply) => {
    const body = z.object({
      version: z.string().nullish(),
      createdAt: z.string().nullish(),
      // .strict(): an unexpected key is an error, not something to drop quietly. A
      // client that sends `export_url` here has a bug, and stripping it would hide
      // that while making the refusal in planFromEntries unreachable.
      files: z.array(z.object({
        category: z.string().min(1).max(120),
        filename: z.string().min(1).max(400),
        part: z.number().int().nullish(),
        // 64 hex characters, or null when the browser could not hash (an insecure
        // origin). Anything else is refused rather than stored.
        urlFingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullish()
      }).strict()).min(1).max(200)
    }).strict().parse(req.body);

    const plan = planFromEntries(body.files.map(f => ({ category: f.category, filename: f.filename, part: f.part ?? null })));
    const fingerprints = body.files.map(f => f.urlFingerprint).filter((f): f is string => Boolean(f));
    const seen = fingerprints.length
      ? await lookupByFingerprints(uid(req), fingerprints).catch(() => new Map())
      : new Map();

    return reply.send({
      provider: 'claude' as const,
      mode: 'manifest' as const,
      delivery: 'browser' as const,
      version: body.version ?? null,
      createdAt: body.createdAt ?? null,
      totalFiles: plan.length,
      declaredFiles: plan.length,
      urlsConsumed: false,
      categories: plan.map(entry => {
        const original = body.files.find(f => path.basename(f.filename) === entry.filename);
        return {
          category: entry.category,
          filename: entry.filename,
          part: entry.part,
          supported: (CATEGORY_PRIORITY as readonly string[]).includes(entry.category),
          disposition: entry.disposition,
          alreadyUsed: Boolean(original?.urlFingerprint && isSpent(seen.get(original.urlFingerprint)))
        };
      })
    });
  });

  /**
   * Open a browser-download session — the default way a Claude export is imported.
   *
   * THE BODY CARRIES NO URLs. The dashboard parses the manifest locally and keeps
   * every export_url in browser memory; what arrives here is the package list, so a
   * bearer credential for the user's whole history is never written to DAMC's
   * database. `planFromEntries` refuses a body containing one rather than storing
   * it quietly.
   *
   * The watch folder is where the browser's downloads land, so its directories are
   * created here and its state is returned — a session with nothing watching the
   * folder would wait forever for files that are already on disk.
   */
  app.post('/v1/import/claude/manifest/session', async (req, reply) => {
    const body = z.object({
      version: z.string().nullish(),
      createdAt: z.string().nullish(),
      // .strict() for the same reason as the preview route above: a body carrying an
      // export_url must fail loudly. Every download URL belongs in the browser.
      files: z.array(z.object({
        category: z.string().min(1).max(120),
        filename: z.string().min(1).max(400),
        part: z.number().int().nullish()
      }).strict()).min(1).max(200)
    }).strict().parse(req.body);

    const session = await startSession(uid(req),
      body.files.map(f => ({ category: f.category, filename: f.filename, part: f.part ?? null })),
      { version: body.version ?? null, createdAt: body.createdAt ?? null });
    await ensureWatchFolders();
    return reply.code(201).send({ session, watcher: await getWatcherStatus() });
  });

  /** The session to show, with the watch-folder state the user has to act on. */
  app.get('/v1/import/claude/manifest/session', async req => ({
    session: await getSession(uid(req)),
    watcher: await getWatcherStatus()
  }));

  app.get('/v1/import/claude/manifest/session/:jobId', async (req, reply) => {
    const jobId = z.string().uuid().parse((req.params as any).jobId);
    const session = await getSession(uid(req), jobId);
    if (!session) return reply.code(404).send({ error: 'NOT_FOUND', message: 'No Claude export session under that id.' });
    return reply.send({ session, watcher: await getWatcherStatus() });
  });

  /**
   * Record that the user opened one package's download link in their browser.
   *
   * The page opens the URL itself — the server never sees it. This call exists so
   * the *rule* about single-use links lives in the state machine rather than in the
   * page: once a package's file has arrived, this refuses, and the button is gone.
   */
  app.post('/v1/import/claude/manifest/session/:jobId/packages/:packageId/open', async (req, reply) => {
    const params = z.object({ jobId: z.string().uuid(), packageId: z.string().uuid() }).parse(req.params);
    const opened = await openPackage(uid(req), params.packageId);
    return reply.send({ package: opened, session: await getSession(uid(req), params.jobId) });
  });

  /**
   * Fetch and import the packages a manifest lists, server-side.
   *
   * NOT the default path, and not what the dashboard uses: claude.ai answers a
   * server-side client with a bot-protection page, and DAMC will not pretend to be
   * a browser to get past it. Kept because it is correct for any host that serves
   * the file, and because a blocked attempt now parks the job at
   * 'awaiting_download' rather than claiming the import failed — the browser
   * session above is still available.
   *
   * Returns a jobId as soon as the job row exists rather than holding the request
   * open: five archives can be several gigabytes.
   */
  app.post('/v1/import/claude/manifest', async (req, reply) => {
    const manifest = await manifestFromRequest(req);
    const handle = await startManifestImport(uid(req), manifest, { source: 'web' });
    return reply.code(202).send({
      jobId: handle.jobId,
      provider: 'claude',
      mode: 'manifest',
      status: 'queued',
      totalFiles: manifest.files.length,
      categories: manifest.files.map(f => f.category)
    });
  });

  // Live progress for an in-flight import, plus whatever this process is running.
  // The durable copy lives on the job row (sync_jobs.stats.progress), so a job
  // that finished or was interrupted is still answerable from /v1/sync/jobs.
  app.get('/v1/import/progress', async req => ({ active: listActiveProgress(uid(req)) }));
  app.get('/v1/import/progress/:jobId', async (req, reply) => {
    const jobId = z.string().uuid().parse((req.params as any).jobId);
    const progress = getProgress(jobId, uid(req));
    if (!progress) return reply.code(404).send({ error: 'NOT_FOUND', message: 'No import is running under that job id in this process. Check /v1/sync/jobs for its recorded outcome.' });
    return reply.send(progress);
  });
  app.get('/v1/sync/jobs', async req => listSyncJobs(uid(req), Number((req.query as any).limit ?? 20)));
  // Watch-folder import: same runImportJob pipeline, triggered by a file
  // appearing in DAMC_IMPORT_WATCH_DIR instead of an upload or CLI call.
  app.get('/v1/import/watch/status', async () => getWatcherStatus());
  // The on/off choice is persisted so the watcher comes back on its own after a
  // container or machine restart — see watch-state-service.ts.
  app.post('/v1/import/watch/start', async req => {
    const status = await startWatcher(uid(req));
    await setWatchFolderEnabled(uid(req), true);
    return status;
  });
  app.post('/v1/import/watch/stop', async req => {
    const status = await stopWatcher();
    await setWatchFolderEnabled(uid(req), false);
    return status;
  });
  app.get('/v1/memories', async req => {
    const q = req.query as any;
    const opts = {
      projectId: optionalUuid(q.projectId), status: optionalText(q.status), provider: optionalText(q.provider),
      minImportance: optionalNumber(q.minImportance), sort: optionalText(q.sort), limit: Number(q.limit ?? 50)
    };
    if (q.q) return searchMemories(uid(req), q.q, opts);
    return listMemories(uid(req), { ...opts, type: optionalText(q.type) as any, status: opts.status as any });
  });
  app.get('/v1/memories/providers', async req => listMemoryProviders(uid(req)));
  app.get('/v1/memories/:id', async (req, reply) => {
    const id = z.string().uuid().parse((req.params as any).id);
    const detail = await getMemoryDetail(uid(req), id);
    if (!detail) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Memory not found' });
    return reply.send(detail);
  });
  app.patch('/v1/memories/:id/status', async req => { const body = z.object({ status: z.enum(['candidate','confirmed','active','superseded','deprecated','archived']), reason: z.string().max(500).optional() }).parse(req.body); return setMemoryStatus(uid(req), z.string().uuid().parse((req.params as any).id), body.status, body.reason); });
  app.post('/v1/memories/:id/link', async req => { const id = z.string().uuid().parse((req.params as any).id); const body = z.object({ projectId: z.string().uuid().optional() }).parse(req.body ?? {}); return linkRelatedMemories(uid(req), id, body.projectId); });
  app.get('/v1/context', async req => { const q = req.query as any; z.string().min(1).parse(q.q); return buildContextPackage(uid(req), q.q, q.projectId); });
  app.get('/v1/state', async req => { const q = req.query as any; const projectId = q.projectId ? z.string().uuid().parse(q.projectId) : undefined; return buildCurrentState(uid(req), projectId); });
  app.get('/v1/state/cached', async req => { const q = req.query as any; const projectId = q.projectId ? z.string().uuid().parse(q.projectId) : undefined; return (await getStoredCurrentState(uid(req), projectId)) ?? buildCurrentState(uid(req), projectId); });
  app.get('/v1/graph', async req => getGraph(uid(req), optionalUuid((req.query as any).projectId)));
  app.post('/v1/export/json', async req => exportJson(uid(req)));
  app.post('/v1/export/obsidian', async req => exportObsidian(uid(req)));
  // Read-only view of the vault folder for the Obsidian page: does it exist, when
  // did a sync last finish, how many notes are there, and what would sync next.
  app.get('/v1/export/obsidian/status', async req => obsidianStatus(uid(req)));
  app.post('/v1/backup/github', async req => backupToGitHub(uid(req)));

  // Remote Access — publish DAMC to cloud AI clients without opening a port:
  // a managed cloudflared tunnel (named when DAMC_TUNNEL_TOKEN is set, quick
  // otherwise), or the operator's own DAMC_PUBLIC_URL.
  app.get('/v1/remote-access', async req => getRemoteAccessState(uid(req)));
  app.post('/v1/remote-access/enable', async req => enableRemoteAccess(uid(req)));
  app.post('/v1/remote-access/disable', async req => disableRemoteAccess(uid(req)));
  app.post('/v1/remote-access/verify', async req => {
    const body = z.object({ endpoint: z.string().trim().max(300) }).parse(req.body ?? {});
    const endpoint = body.endpoint || (await getRemoteAccessState(uid(req))).endpoint;
    if (!endpoint) return { ok: false, status: null, message: 'No endpoint configured yet.' };
    const result = await verifyEndpoint(endpoint);
    // Persisted as last-reachable evidence for the Sync Center. The probe
    // result contains no credentials — safe to store.
    await recordVerifyResult(uid(req), endpoint, result.ok);
    return result;
  });
  app.post('/v1/auth/api-keys', async req => { const body = z.object({ label: z.string().min(1).max(100).default('default') }).parse(req.body ?? {}); return createApiKey(uid(req), body.label); });
  app.get('/v1/auth/api-keys', async req => ({ keys: await listApiKeys(uid(req)) }));
  app.delete('/v1/auth/api-keys/:id', async (req, reply) => {
    const id = z.string().uuid().parse((req.params as any).id);
    const revoked = await revokeApiKey(uid(req), id);
    if (!revoked) return reply.code(404).send({ error: 'NOT_FOUND', message: 'No active API key with that id.' });
    return reply.send({ revoked: true, id });
  });
  app.post('/v1/auth/bootstrap', async req => {
    const body = z.object({ email: z.string().email().optional(), displayName: z.string().max(120).optional(), projectName: z.string().max(120).optional() }).parse(req.body ?? {});
    return bootstrapUser(String(req.headers['x-damc-admin-key'] ?? ''), env.DAMC_API_KEY_ADMIN, body,
      { firstRun: Boolean((req as any).damcFirstRun) });
  });

  // MCP JSON-RPC boundary — the surface every AI client shares.
  // Dispatch lives in src/connectors/mcp so adding a client never means touching
  // the memory engine. The 1.0.0 damc_context tool is still exposed.
  app.post('/v1/mcp', async (req, reply) => {
    const response = await handleMcpRequest(req.body, {
      userId: uid(req),
      headers: req.headers as Record<string, unknown>,
      logError: (error, method) => req.log.error({ err: error, method }, 'mcp request failed')
    });
    return reply.send(response);
  });

  // Plain-HTTP view of the same connector surface, for clients that speak REST.
  app.get('/v1/connectors/mcp/tools', async () => ({ protocolVersion: MCP_PROTOCOL_VERSION, tools: listTools() }));

  // The shared DAMC skill text (integrations/SKILL.md) as data: the Sync
  // Center's "Copy Skill" button and any client that can fetch a URL get the
  // exact rules every AI follows — never a paraphrase that could drift.
  app.get('/v1/connectors/skill', async () => ({ path: 'integrations/SKILL.md', content: await readSkillText() }));

  // Remote MCP Gateway — the published /mcp endpoint. Same tool surface as
  // /v1/mcp, but authentication is mandatory here even in dev mode, and
  // requests are rate-limited per API key. See src/http/mcp-gateway.ts.
  await registerMcpGateway(app);
}

/**
 * Origin used in generated AI connection configs. DAMC_PUBLIC_URL wins when
 * the gateway is published under a different host than the dashboard; otherwise
 * the request's own origin is the best guess (right for tunneled and loopback
 * setups alike).
 */
/**
 * Read a Claude manifest out of a request, whichever way it arrived.
 *
 * The dashboard posts the file the user selected (multipart); the CLI and any
 * scripted caller post the JSON itself. Both are the same 1.5 KB document, so
 * both are accepted rather than forcing one shape.
 *
 * A multipart upload goes through the same temp-file path as any other upload —
 * including the size limit — and is deleted before this returns.
 */
async function manifestFromRequest(req: any): Promise<ClaudeManifest> {
  if (typeof req.isMultipart === 'function' && req.isMultipart()) {
    const file = await req.file();
    if (!file) throw new AppError('FILE_REQUIRED', 'Attach the manifest JSON file Claude gave you.', 400);
    const upload = await storeUploadToTempFile(file);
    try {
      const manifest = await readManifestFile(upload.path);
      if (!manifest) {
        throw new AppError('MANIFEST_INVALID',
          'That file is not a Claude export manifest. Upload the small JSON file from "Export your data" — it lists the export packages.', 400);
      }
      return manifest;
    } finally {
      await upload.cleanup();
    }
  }
  if (!looksLikeClaudeManifest(req.body)) {
    throw new AppError('MANIFEST_INVALID',
      'Post the Claude export manifest, either as a JSON body or as an uploaded file.', 400);
  }
  return parseClaudeManifest(req.body);
}

function publicOrigin(req: { protocol: string; headers: Record<string, unknown> }): string {
  if (env.DAMC_PUBLIC_URL) return env.DAMC_PUBLIC_URL.replace(/\/+$/, '');
  const host = typeof req.headers.host === 'string' ? req.headers.host : 'localhost:8787';
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : req.protocol;
  return `${proto}://${host}`;
}

/**
 * Locate integrations/SKILL.md in both layouts (dev tree and built image),
 * mirroring scripts/migrate.ts. Read per request so pack updates never need
 * a restart to show up in the Sync Center.
 */
const SKILL_CANDIDATES = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [path.resolve(here, '../../integrations/SKILL.md'), path.resolve(here, '../integrations/SKILL.md')];
})();

async function readSkillText(): Promise<string> {
  for (const candidate of SKILL_CANDIDATES) {
    try {
      return await readFile(candidate, 'utf8');
    } catch { /* try the next layout */ }
  }
  throw new Error('Skill file not found');
}
