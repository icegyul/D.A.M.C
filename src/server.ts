import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { env } from './config/env.js';
import { registerRoutes } from './http/routes.js';
import { AppError } from './errors/app-error.js';
import { registerStatic } from './http/static.js';
import { corsOrigin } from './http/cors.js';
import { ensureLocalOwner, LOCAL_OWNER } from './http/auth.js';
import { startWatcher } from './services/import-watch-service.js';
import { isWatchFolderEnabled } from './services/watch-state-service.js';
import { resumeRemoteAccess } from './services/remote-access-service.js';
import { failInterruptedImports } from './services/import-progress-service.js';
import { resetInterruptedPackages } from './repositories/claude-export-repository.js';
import { reconcileRetainedPackages } from './services/claude-package-service.js';
import { sweepImportTempDir } from './services/import-upload-service.js';

const app = Fastify({ logger: { level: env.LOG_LEVEL } });
await app.register(cors, { origin: corsOrigin(env.CORS_ORIGIN) });
// fileSize must be passed explicitly: when the option is omitted
// @fastify/multipart substitutes fastify.initialConfig.bodyLimit, which is 1 MB —
// so "no limit configured" would mean a 1 MB ceiling, not an unlimited one.
await app.register((await import('@fastify/multipart')).default, {
  limits: { fileSize: env.DAMC_IMPORT_MAX_FILE_SIZE_BYTES }
});
await app.register(sensible);

app.setErrorHandler((error, _request, reply) => {
  const err = error as Error & { statusCode?: number; code?: string };
  if (err instanceof AppError) return reply.code(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
  if (err.name === 'ZodError') return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Invalid request', details: err });
  // Fastify and its plugins raise errors that already carry the right status —
  // FST_REQ_FILE_TOO_LARGE is built with 413, the parts/files limits likewise.
  // This handler used to type `statusCode` and then never read it, so every one
  // of them reached the browser as 500 "Internal server error": a condition the
  // user could fix, reported as a server fault. 5xx still gets the generic
  // message, because those are ours and must not leak internals.
  if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
    app.log.warn({ code: err.code, statusCode: err.statusCode, msg: err.message }, 'client error');
    return reply.code(err.statusCode).send({
      error: err.code ?? 'BAD_REQUEST',
      message: err.message,
      ...(err.code === 'FST_REQ_FILE_TOO_LARGE' ? { details: { maxBytes: env.DAMC_IMPORT_MAX_FILE_SIZE_BYTES } } : {})
    });
  }
  app.log.error(err);
  return reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error' });
});

// The local owner row every table's foreign key points at. Provisioned whatever the
// auth mode is: the boot tasks below act as this id, and gating it on dev mode meant
// an install with authentication enforced had a watch folder writing against a user
// that did not exist. Never fatal — the API still comes up and reports.
try {
  await ensureLocalOwner();
} catch (error) {
  app.log.error({ err: error }, 'could not provision the local owner row; writes will fail until the database is reachable');
}

// An import that was streaming when the process died leaves its job row in
// 'running' forever, and its upload temp file on disk. Both are reconciled here
// rather than left to accumulate. Re-running the import is safe: conversations
// deduplicate, so nothing is imported twice.
try {
  const interrupted = await failInterruptedImports();
  if (interrupted) app.log.warn({ interrupted }, 'marked imports interrupted by a previous shutdown as failed');
} catch (error) {
  app.log.error({ err: error }, 'could not reconcile interrupted imports');
}
// A Claude export package that was being imported when the process died goes back
// to 'opened' — not to 'awaiting_download', because its single-use link is already
// spent. If the archive is still in the watch folder the watcher re-detects it and
// the session finishes on its own.
try {
  const reopened = await resetInterruptedPackages();
  if (reopened) app.log.warn({ reopened }, 'reset Claude export packages interrupted by a previous shutdown');
  // retainArchive renames the file out of the watch folder and then writes the row.
  // A death between those two steps leaves the archive safely on disk and the package
  // still waiting for it, so the session would ask the user to re-fetch a spent link
  // for a file DAMC already has. This looks at the disk and closes that gap.
  const recovered = await reconcileRetainedPackages();
  if (recovered) app.log.warn({ recovered }, 'recovered Claude export packages whose archive was already on disk');
} catch (error) {
  app.log.error({ err: error }, 'could not reset interrupted Claude export packages');
}
try {
  const swept = await sweepImportTempDir();
  if (swept) app.log.info({ swept }, 'removed orphaned import upload temp files');
} catch (error) {
  app.log.error({ err: error }, 'could not sweep the import temp directory');
}

await registerRoutes(app);
await registerStatic(app);

// Off unless an operator opted in — the watch folder never starts itself
// silently. It resumes for exactly two reasons: the deployment sets
// DAMC_IMPORT_WATCH_AUTOSTART, or the operator switched it on in the UI and
// that choice was persisted (watch-state-service). The second is what makes
// "자동 감시 중" survive a container restart or a Windows reboot instead of
// quietly turning itself off. It always runs as the dev-mode user, same as any
// other unauthenticated request.
try {
  const resume = env.DAMC_IMPORT_WATCH_AUTOSTART || await isWatchFolderEnabled(LOCAL_OWNER);
  if (resume) {
    await startWatcher(LOCAL_OWNER);
    app.log.info({ dir: env.DAMC_IMPORT_WATCH_DIR, reason: env.DAMC_IMPORT_WATCH_AUTOSTART ? 'autostart' : 'persisted' }, 'import watch folder started');
  }
} catch (error) {
  app.log.error({ err: error }, 'could not restore the import watch folder');
}

// Remote Access left on by the operator comes back after a restart: own-endpoint
// mode needs nothing (the proxy is external), quick tunnels get a fresh URL.
try {
  await resumeRemoteAccess(LOCAL_OWNER);
} catch (error) {
  app.log.error({ err: error }, 'could not restore Remote Access');
}

await app.listen({ port: env.PORT, host: env.HOST });
