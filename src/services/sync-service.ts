import { query } from '../db/pool.js';
import { env } from '../config/env.js';
import { ChatGPTConnector } from '../connectors/chatgpt-connector.js';
import { ClaudeConnector } from '../connectors/claude-connector.js';
import { ingestConversation, extractCandidates } from './ingestion-service.js';
import { parseImportPackage } from './import-package-service.js';
import { beginProgress, updateProgress, endProgress, persistProgress } from './import-progress-service.js';
import type { ConversationInput } from '../types/domain.js';
import type { ImportStreamReporter } from './import-stream-service.js';

export async function createSyncJob(userId: string, provider: 'chatgpt' | 'claude', direction = 'inbound') {
  const r = await query<{ id: string }>(
    `INSERT INTO sync_jobs(user_id,connector,direction,status,started_at,attempts) VALUES($1,$2,$3,'queued',now(),0) RETURNING id`,
    [userId, provider, direction]
  );
  return r.rows[0]!.id;
}

export interface ImportJobOptions {
  /** Where the job was triggered from — recorded in stats for the import history UI. */
  source?: 'web' | 'cli' | 'watch';
  fileName?: string;
  /**
   * Size of the uploaded file. Recorded in stats only so the dashboard can
   * rebuild its completion banner after a reload, when the upload itself is long
   * gone. Nothing in the import pipeline reads it.
   */
  fileBytes?: number;
}

/**
 * Runs one import through the same pipeline every entry point shares: web
 * upload, CLI and the watch folder all call this. A single malformed
 * conversation must not lose the rest of the batch (or its own already-
 * written messages/memories — ingestConversation commits per conversation),
 * so each conversation is isolated in its own try/catch. The job is marked
 * 'failed' only when nothing could be imported at all, 'partial' when some
 * conversations errored and others succeeded, and 'completed' otherwise.
 */
export async function runImportJob(userId: string, provider: 'chatgpt' | 'claude', payload: unknown, opts: ImportJobOptions = {}) {
  const jobId = await createSyncJob(userId, provider);
  // Kept for parity with the connector boundary; parsing itself does not touch
  // provider-specific logic beyond parseImportPackage.
  void (provider === 'chatgpt' ? new ChatGPTConnector() : new ClaudeConnector());

  let conversations: ConversationInput[];
  try {
    conversations = Array.isArray(payload) && payload.every(x => typeof x === 'object' && x !== null && 'messages' in x)
      ? payload as ConversationInput[]
      : parseImportPackage(provider, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await query(`UPDATE sync_jobs SET status='failed',finished_at=now(),error_message=$1,stats=$2 WHERE id=$3`,
      [message, { source: opts.source ?? 'web', fileName: opts.fileName ?? null }, jobId]);
    throw error;
  }

  let imported = 0, deduplicated = 0, memoriesCreated = 0, superseded = 0, decisionCount = 0, taskCount = 0;
  const errors: Array<{ conversation: string; message: string }> = [];

  for (const c of conversations) {
    try {
      const r = await ingestConversation(userId, c);
      if (r.deduplicated) deduplicated++; else imported++;
      memoriesCreated += r.memoriesCreated;
      superseded += r.memoriesSuperseded;
      if (!r.deduplicated) {
        for (const candidate of extractCandidates(c)) {
          if (candidate.type === 'DECISION') decisionCount++;
          else if (candidate.type === 'TASK') taskCount++;
        }
      }
    } catch (error) {
      errors.push({ conversation: c.externalId ?? c.title ?? 'unknown', message: error instanceof Error ? error.message : String(error) });
    }
  }

  const attempted = conversations.length;
  const status = errors.length === 0 ? 'completed' : (imported + deduplicated) > 0 ? 'partial' : 'failed';
  const stats = {
    source: opts.source ?? 'web', fileName: opts.fileName ?? null,
    conversationsDetected: attempted, conversationsImported: imported,
    imported, deduplicated, memoriesCreated, superseded, decisionCount, taskCount,
    errors: errors.slice(0, 20)
  };
  await query(`UPDATE sync_jobs SET status=$1,finished_at=now(),stats=$2,error_message=$3 WHERE id=$4`,
    [status, stats, errors.length ? `${errors.length}/${attempted} conversation(s) failed` : null, jobId]);

  if (status === 'failed' && attempted > 0) {
    // Nothing landed at all — surface it as a thrown error too, so CLI/web
    // callers that only look at try/catch (not the stats body) still see it.
    throw new Error(errors[0]?.message ?? 'Import failed');
  }

  return { jobId, provider, status, imported, deduplicated, memoriesCreated, superseded, decisionCount, taskCount, conversationsDetected: attempted, errors };
}

export type ConversationStreamFactory = (report?: ImportStreamReporter) => AsyncIterable<ConversationInput>;

/**
 * Everything one conversation stream produced.
 *
 * Owned by the caller rather than returned, so a read failure part-way through
 * still leaves the counts for what already landed — nothing is rolled back,
 * because ingestConversation commits per conversation on purpose.
 */
export interface StreamIngestCounters {
  attempted: number;
  imported: number;
  deduplicated: number;
  memoriesCreated: number;
  superseded: number;
  decisionCount: number;
  taskCount: number;
  messages: number;
  errors: Array<{ conversation: string; message: string }>;
  shardsTotal: number;
  shardsProcessed: number;
  currentShard: string;
  shardNames: string[];
}

export function createStreamCounters(): StreamIngestCounters {
  return {
    attempted: 0, imported: 0, deduplicated: 0, memoriesCreated: 0, superseded: 0,
    decisionCount: 0, taskCount: 0, messages: 0, errors: [],
    shardsTotal: 1, shardsProcessed: 0, currentShard: '', shardNames: []
  };
}

/**
 * Ingest a conversation stream into whatever job the caller is running.
 *
 * The single place conversations are turned into rows, shared by the file-upload
 * path (runStreamingImportJob) and the Claude manifest path — so a manifest
 * import cannot drift from an upload in how it dedupes, counts or isolates a bad
 * conversation.
 *
 * A single malformed conversation must not lose the rest of the stream, so each
 * is isolated in its own try/catch and recorded in `counters.errors`.
 */
export async function ingestConversationStream(
  userId: string,
  source: ConversationStreamFactory,
  counters: StreamIngestCounters,
  opts: { batchSize?: number; onBatch?: () => Promise<void> | void } = {}
): Promise<void> {
  const batchSize = opts.batchSize ?? env.DAMC_IMPORT_BATCH_SIZE;

  // A sharded export (conversations-000.json, -001.json, ...) reports each shard
  // as reading moves onto it, so progress advances on two axes: conversations
  // within the current shard, and shards within the export.
  const report: ImportStreamReporter = {
    shard(index, name, total) {
      counters.shardsTotal = total;
      counters.shardsProcessed = index;
      counters.currentShard = name;
      if (name && !counters.shardNames.includes(name)) counters.shardNames.push(name);
    }
  };

  let batch = 0;
  for await (const conversation of source(report)) {
    counters.attempted++;
    counters.messages += conversation.messages.length;
    try {
      const result = await ingestConversation(userId, conversation);
      if (result.deduplicated) counters.deduplicated++; else counters.imported++;
      counters.memoriesCreated += result.memoriesCreated;
      counters.superseded += result.memoriesSuperseded;
      if (!result.deduplicated) {
        for (const candidate of extractCandidates(conversation)) {
          if (candidate.type === 'DECISION') counters.decisionCount++;
          else if (candidate.type === 'TASK') counters.taskCount++;
        }
      }
    } catch (error) {
      counters.errors.push({
        conversation: conversation.externalId ?? conversation.title ?? 'unknown',
        message: error instanceof Error ? error.message : String(error)
      });
    }
    if (++batch >= batchSize) {
      batch = 0;
      await opts.onBatch?.();
    }
  }
}

/**
 * Import from a stream of conversations rather than an array.
 *
 * Same contract, same counters and the same per-conversation isolation as
 * runImportJob — it differs only in never holding the export. Conversations
 * arrive from an async generator (see import-stream-service) and are ingested in
 * batches of DAMC_IMPORT_BATCH_SIZE, with progress committed to the job row at
 * each batch boundary.
 *
 * IDEMPOTENCY IS UNCHANGED, and that is the point. Each conversation still goes
 * through ingestConversation, which dedupes on the (user_id, provider,
 * external_id) uniqueness that conversations already carry and returns
 * `deduplicated: true` instead of writing a second copy. So re-running an import
 * after a failure — or after a restart killed one halfway — re-reads the whole
 * file but only writes what is genuinely new. There is no batch bookkeeping to
 * get wrong, because the database, not the importer, is what remembers.
 */
/**
 * Opens a fresh conversation stream. The optional reporter lets a sharded
 * export announce which shard reading has reached, so progress can advance on
 * shards as well as conversations. A zero-argument factory is still valid.
 */
export async function runStreamingImportJob(
  userId: string,
  provider: 'chatgpt' | 'claude',
  source: ConversationStreamFactory,
  opts: ImportJobOptions = {}
) {
  const jobId = await createSyncJob(userId, provider);
  const fileName = opts.fileName ?? null;
  const progress = beginProgress(jobId, provider, fileName, new Date().toISOString(), {}, userId);

  await query(`UPDATE sync_jobs SET status='running' WHERE id=$1`, [jobId]);

  const c = createStreamCounters();
  const commit = async (phase: 'reading' | 'importing' | 'finished') => {
    const shardsDone = phase === 'finished' ? c.shardsTotal : c.shardsProcessed;
    const counters = {
      processed: c.attempted, imported: c.imported, deduplicated: c.deduplicated,
      failed: c.errors.length, memoriesCreated: c.memoriesCreated, phase,
      shardsTotal: c.shardsTotal, shardsProcessed: shardsDone, currentShard: c.currentShard
    };
    updateProgress(jobId, counters, new Date().toISOString());
    await persistProgress(jobId, { ...progress, ...counters })
      .catch(() => { /* progress is advisory; never fail an import over it */ });
  };

  try {
    await ingestConversationStream(userId, source, c, { onBatch: () => commit('importing') });
  } catch (error) {
    // A read failure (corrupt archive, truncated JSON) after some conversations
    // already committed: record what landed, then surface the cause. Nothing is
    // rolled back — ingestConversation commits per conversation on purpose.
    const message = error instanceof Error ? error.message : String(error);
    await commit('finished');
    endProgress(jobId);
    await query(`UPDATE sync_jobs SET status=$1,finished_at=now(),error_message=$2,stats=COALESCE(stats,'{}'::jsonb)||$3::jsonb WHERE id=$4`,
      [(c.imported + c.deduplicated) > 0 ? 'partial' : 'failed', message,
        JSON.stringify({ source: opts.source ?? 'web', fileName, fileBytes: opts.fileBytes ?? null, conversationsDetected: c.attempted, messages: c.messages, imported: c.imported, deduplicated: c.deduplicated, memoriesCreated: c.memoriesCreated, superseded: c.superseded, decisionCount: c.decisionCount, taskCount: c.taskCount, shardCount: c.shardsTotal, shardNames: c.shardNames, errors: c.errors.slice(0, 20) }),
        jobId]);
    throw error;
  }

  await commit('finished');
  endProgress(jobId);

  const status = c.errors.length === 0 ? 'completed' : (c.imported + c.deduplicated) > 0 ? 'partial' : 'failed';
  const stats = {
    source: opts.source ?? 'web', fileName, fileBytes: opts.fileBytes ?? null,
    conversationsDetected: c.attempted, messages: c.messages, conversationsImported: c.imported,
    imported: c.imported, deduplicated: c.deduplicated, memoriesCreated: c.memoriesCreated,
    superseded: c.superseded, decisionCount: c.decisionCount, taskCount: c.taskCount,
    // How many JSON documents this export turned out to be, kept on the job so a
    // sharded import is distinguishable from a single-file one after the fact.
    shardCount: c.shardsTotal, shardNames: c.shardNames,
    errors: c.errors.slice(0, 20)
  };
  await query(`UPDATE sync_jobs SET status=$1,finished_at=now(),stats=COALESCE(stats,'{}'::jsonb)||$2::jsonb,error_message=$3 WHERE id=$4`,
    [status, JSON.stringify(stats), c.errors.length ? `${c.errors.length}/${c.attempted} conversation(s) failed` : null, jobId]);

  if (status === 'failed' && c.attempted > 0) {
    throw new Error(c.errors[0]?.message ?? 'Import failed');
  }

  return { jobId, provider, status, imported: c.imported, deduplicated: c.deduplicated, memoriesCreated: c.memoriesCreated, superseded: c.superseded, decisionCount: c.decisionCount, taskCount: c.taskCount, conversationsDetected: c.attempted, messages: c.messages, shardCount: c.shardsTotal, shardNames: c.shardNames, errors: c.errors };
}

export async function listSyncJobs(userId: string, limit = 20) {
  const r = await query(`SELECT id,connector,direction,status,cursor,started_at AS "startedAt",finished_at AS "finishedAt",attempts,error_message AS "errorMessage",stats,created_at AS "createdAt" FROM sync_jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`, [userId, Math.min(Math.max(limit, 1), 100)]);
  return r.rows;
}
