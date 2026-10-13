import * as api from '../api.js';
import { state, idle, loading, ready, failed } from '../state.js';
import { esc, attr, badge, sectionTitle, statTile, bytes, num, dateTime, relative, region, toast } from '../ui.js';
import { t } from '../i18n.js';
import {
  outcomeFromResult, outcomeFromJob, lastFinishedJob, bannerState, errorActionKey, progressPercent,
  manifestProgress, manifestFileLabelKey, manifestFileTone, lastManifestJob, showsFileOutcome,
  packageStatusLabelKey, packageStatusTone, packageAction, sessionProgress, sessionBanner,
  manifestMatchesSession, normalizePackageName, belongsToSession, packageErrorKey
} from '../import-outcome.js';

const PROVIDERS = [
  { id: 'chatgpt', label: 'ChatGPT', hint: 'import.chatgptHint' },
  { id: 'claude', label: 'Claude', hint: 'import.claudeHint' }
];

function cliCommand(provider, examplePath) {
  return `npm run damc:import -- ${provider} "${examplePath}"`;
}

export default {
  id: 'import',

  async mount(root) {
    const view = state.importer;
    let watcher = idle();
    let recent = idle();

    /** The server's configured upload ceiling, straight off the cached /health payload. */
    const maxUploadBytes = () => api.connection.health?.limits?.importFileBytes ?? null;

    /**
     * A 413 is the one failure with a better story than the server's own sentence:
     * it is the file, not the backend, and the fix is a number the user can see.
     * Everything else renders the server's message unchanged.
     */
    function errorText(error) {
      if (error?.status === 413 || error?.code === 'FILE_TOO_LARGE' || error?.code === 'FST_REQ_FILE_TOO_LARGE') {
        const max = error?.details?.maxBytes ?? maxUploadBytes();
        const size = bytes(view.file?.size ?? 0);
        return max ? t('import.tooLarge', { size, max: bytes(max) }) : t('import.tooLargeNoMax', { size });
      }
      return error?.message ?? t('ui.unexpectedError');
    }

    async function preview() {
      if (!view.file) return;
      view.busy = 'preview'; view.error = null; view.result = null; view.manifest = null; paint();
      try {
        // A manifest is recognised HERE, before anything is uploaded. That ordering
        // is the whole safety argument for this flow: the file holds five live
        // single-use URLs, each redeemable for the user's entire Claude history, and
        // uploading it to learn what it is would write them to the server's disk.
        // Only the package list — category, filename, part — is ever sent.
        const local = await readLocalManifest(view.file);
        if (local) {
          attachPackageUrls(local);
          view.manifest = await api.previewClaudePackagePlan(local);
          view.preview = null;
          await loadSession();
          view.reattached = manifestMatchesSession(
            (view.manifest?.categories ?? []).map(c => c.filename), view.session);
        } else {
          view.preview = await api.previewImport(view.provider, view.file);
        }
      } catch (error) {
        view.preview = null;
        view.error = error;
      }
      view.busy = false;
      paint();
    }

    /**
     * Is the selected file a Claude export manifest? Read locally, never uploaded.
     *
     * Only the first megabyte is examined: a manifest is about 1.5 KB, and the same
     * box accepts multi-gigabyte exports that must not be read into a string.
     */
    async function readLocalManifest(file) {
      if (!file || view.provider !== 'claude') return null;
      if (file.size === 0 || file.size > 1024 * 1024) return null;
      if (/\.zip$/i.test(file.name)) return null;
      try {
        const parsed = JSON.parse((await file.slice(0, 1024 * 1024).text()).replace(/^\uFEFF/, ''));
        const files = parsed?.data_files;
        if (!Array.isArray(files) || !files.length) return null;
        const usable = files.filter(f => typeof f?.export_url === 'string'
          && typeof f?.category === 'string' && typeof f?.filename === 'string');
        if (!usable.length) return null;
        return { version: parsed.version ?? null, createdAt: parsed.created_at ?? null, files: usable };
      } catch {
        return null;
      }
    }

    /**
     * Read the manifest's download URLs out of the local file, into this tab only.
     *
     * This is the whole reason the browser-download flow is safe to offer: an
     * export_url grants one download of the user's entire Claude history, and it
     * never leaves this tab — not to the server, not into the DOM, not into a
     * data- attribute that a screenshot or a copied element would carry. The map
     * is keyed by the normalised filename, which is also how the server matches an
     * arriving download, so the two cannot disagree about which package a link
     * belongs to.
     *
     * A reload empties it. That is a deliberate trade: re-selecting the file costs
     * a click and uses no link, whereas persisting the URLs would put a live
     * credential somewhere it could be backed up.
     */
    function attachPackageUrls(local) {
      view.packageUrls = new Map();
      for (const entry of local?.files ?? []) {
        view.packageUrls.set(normalizePackageName(entry.filename), entry.export_url);
      }
    }

    async function loadSession() {
      if (api.isDemo()) return;
      try {
        const response = await api.getClaudePackageSession(view.sessionJobId);
        view.session = response?.session ?? null;
        view.sessionWatcher = response?.watcher ?? null;
        view.sessionJobId = view.session?.jobId ?? null;
      } catch {
        // A failed request is not an answer. Clearing the session here made the whole
        // package list vanish on one timed-out poll — during a container restart, say
        // — and with it the buttons the user was working through. The last known
        // session stays on screen until the server actually says there is none.
      }
    }

    /**
     * Open the session: tell the server which packages to expect.
     *
     * No URL is sent. The server needs the filenames to recognise the downloads
     * when they land in the watch folder, and nothing else.
     */
    async function startPackageSession() {
      if (!view.manifest) return;
      view.busy = 'session'; view.error = null; paint();
      try {
        const response = await api.startClaudePackageSession({
          version: view.manifest.version,
          createdAt: view.manifest.createdAt,
          // From the preview summary, which carries no URLs by construction.
          files: (view.manifest.categories ?? []).map(c => ({ category: c.category, filename: c.filename, part: c.part }))
        });
        view.session = response.session;
        view.sessionJobId = response.session?.jobId ?? null;
        view.sessionWatcher = response.watcher ?? null;
        view.reattached = false;
        startSessionPolling();
      } catch (error) {
        view.error = error;
        toast(errorText(error), 'bad');
      }
      view.busy = false;
      paint();
    }

    /**
     * Hand one package's link to the browser.
     *
     * `window.open` runs first and synchronously, inside the click, because a popup
     * blocker rejects a window opened after an await. Recording the click comes
     * second: if that call fails the download still happens, which is the right way
     * round — the bookkeeping must never be what stops the user getting their data.
     */
    async function downloadPackage(pkg) {
      const url = view.packageUrls?.get(normalizePackageName(pkg.filename));
      if (!url) { toast(t('claude.needsManifest'), 'info'); return; }
      window.open(url, '_blank', 'noopener,noreferrer');
      try {
        const response = await api.markClaudePackageOpened(view.session.jobId, pkg.id);
        view.session = response?.session ?? view.session;
      } catch (error) {
        // A refusal here means the file already arrived — worth showing, not fatal.
        toast(error?.message ?? t('ui.unexpectedError'), 'info');
      }
      startSessionPolling();
      paint();
    }

    /**
     * Follow the session while the user downloads and the watcher imports.
     *
     * Stops once nothing is pending, so a finished session does not poll for ever.
     */
    function stopSessionPolling() {
      if (view.sessionTimer) clearInterval(view.sessionTimer);
      view.sessionTimer = null;
    }

    /**
     * Follow the session while the user downloads and the watcher imports.
     *
     * Its own timer handle, not the upload poller's. Sharing one meant running an
     * ordinary import cancelled the session poll — so the package list froze mid-flow
     * and only came back on a manual reload.
     */
    function startSessionPolling() {
      stopSessionPolling();
      const tick = async () => {
        if (!root.isConnected) { stopSessionPolling(); return; }
        const before = view.session?.packages?.map(p => p.status).join(',');
        await loadSession();
        if (view.session && view.session.status !== 'awaiting_download') {
          stopSessionPolling();
          loadRecent();
        }
        if (before !== view.session?.packages?.map(p => p.status).join(',')) paint();
      };
      view.sessionTimer = setInterval(tick, 2500);
      tick();
    }

    /**
     * Fetch and import the packages a manifest lists.
     *
     * The POST returns a jobId rather than the result: five archives can be
     * several gigabytes, so the page follows the job instead of waiting on a
     * request. Every download link works exactly once, so this is only ever
     * started by an explicit click.
     */
    async function runManifestImport() {
      if (!view.file || !view.manifest) return;
      view.busy = 'manifest'; view.error = null; view.manifestJob = null; view.restored = null;
      paint();
      try {
        const started = await api.startClaudeManifestImport(view.file);
        view.manifestJobId = started.jobId;
        startManifestPolling();
      } catch (error) {
        view.error = error;
        view.busy = false;
        toast(errorText(error), 'bad');
        paint();
      }
    }

    /**
     * Follow a manifest job to completion.
     *
     * Two sources, because they answer different halves: /v1/import/progress has
     * the live phase and counts, and the job row has the per-package table. The
     * job row is also what survives this page being closed.
     */
    function startManifestPolling() {
      stopProgressPolling();
      const tick = async () => {
        if (!root.isConnected) { stopProgressPolling(); return; }
        try {
          const [{ active }, job] = await Promise.all([
            api.getImportProgress(),
            api.getSyncJob(view.manifestJobId)
          ]);
          view.progress = (active ?? []).find(a => a.jobId === view.manifestJobId) ?? null;
          view.manifestJob = job;
          // 'awaiting_download' included: that is where a bot-protection block parks
          // the job, and it is exactly the moment the user needs the page to stop
          // being busy so they can use the browser-download fallback.
          if (job && ['completed', 'partial', 'failed', 'awaiting_download', 'superseded'].includes(job.status)) {
            stopProgressPolling();
            view.busy = false;
            view.justFinished = true;
            view.finishedAt = job.finishedAt ?? new Date().toISOString();
            toast(t(job.status === 'failed' ? 'import.failedTitle' : 'import.doneTitle'),
              job.status === 'completed' ? 'good' : job.status === 'partial' ? 'info' : 'bad');
            loadRecent();
          }
          paint();
        } catch {
          // Polling is a nicety; losing it must never make a running import look
          // broken. The job row still records the outcome.
          stopProgressPolling();
          view.busy = false;
          paint();
        }
      };
      view.progressTimer = setInterval(tick, 1500);
      tick();
    }

    /**
     * Poll server-side progress while the upload is in flight.
     *
     * The import POST does not resolve until the whole export has been ingested,
     * so without this the page can only show an indeterminate bar for what may be
     * several minutes. Stops itself on the first failure — progress is a nicety
     * and must never be the reason an import appears broken.
     */
    function startProgressPolling() {
      stopProgressPolling();
      view.progressTimer = setInterval(async () => {
        // The router replaces the page without an unmount hook, so the poller
        // checks for itself whether it is still on screen. Without this it would
        // keep painting into a detached element until the upload resolved.
        if (!root.isConnected) { stopProgressPolling(); return; }
        try {
          const { active } = await api.getImportProgress();
          const mine = (active ?? []).find(a => a.provider === view.provider) ?? (active ?? [])[0] ?? null;
          if (mine) { view.progress = mine; paint(); }
        } catch {
          stopProgressPolling();
        }
      }, 1200);
    }

    function stopProgressPolling() {
      if (view.progressTimer) clearInterval(view.progressTimer);
      view.progressTimer = null;
    }

    async function runImport() {
      if (!view.file) return;
      view.busy = 'import'; view.error = null; view.progress = null; view.justFinished = false; view.finishedAt = null;
      view.restored = null; // a fresh run replaces any restored banner
      view.manifestJob = null; view.manifestJobId = null;
      paint();
      startProgressPolling();
      try {
        view.result = await api.importFile(view.provider, view.file);
        // The response carries no completion time; the moment it resolved is it.
        view.finishedAt = new Date().toISOString();
        view.justFinished = true;
        const confirmedOnly = view.result.imported === 0 && view.result.deduplicated > 0;
        toast(confirmedOnly
          ? t('import.confirmedSummary', { deduplicated: num(view.result.deduplicated, '0') })
          : t('import.completed', { conversations: view.result.imported, memories: view.result.memoriesCreated }),
          view.result.status === 'partial' ? 'info' : 'good');
        loadRecent();
      } catch (error) {
        view.result = null;
        view.error = error;
        toast(errorText(error), 'bad');
      }
      stopProgressPolling();
      view.busy = false;
      paint();
    }

    function setFile(file) {
      view.file = file ?? null;
      view.preview = null;
      view.manifest = null;
      view.manifestJob = null;
      view.manifestJobId = null;
      view.packageUrls = null;
      view.reattached = false;
      stopSessionPolling();
      view.result = null;
      view.error = null;
      view.progress = null;
      view.justFinished = false;
      // The restored banner describes the *previous* import. Choosing a new file
      // makes it stale and confusing next to a fresh preview, so it goes.
      view.restored = null;
      paint();
      if (file && !api.isDemo()) preview();
    }

    async function loadWatcher() {
      watcher = loading(); paint();
      try { watcher = ready(await api.getWatcherStatus()); } catch (e) { watcher = failed(e); }
      paint();
    }

    async function toggleWatcher() {
      const running = watcher.data?.running;
      try {
        watcher = ready(running ? await api.stopWatcher() : await api.startWatcher());
        toast(running ? t('import.autoStopped') : t('import.autoRunning'), 'good');
      } catch (error) {
        toast(error.message, 'bad');
      }
      paint();
    }

    async function loadRecent() {
      recent = loading(); paint();
      try { recent = ready((await api.getSyncJobs(6))); } catch (e) { recent = failed(e); }
      restoreLastOutcome();
      paint();
    }

    /**
     * Rebuild the completion banner from the newest job after a page reload.
     *
     * Requirement 9. The in-page result lives in module state that a refresh
     * discards, but the job row does not — so a user who reloads after a
     * six-minute import still sees that it completed, instead of an empty page
     * that looks like it never ran. A live result always wins.
     */
    function restoreLastOutcome() {
      if (view.result || view.error || view.busy) return;
      const newest = lastFinishedJob(recent.data);
      view.restored = showsFileOutcome(newest, view.session) ? outcomeFromJob(newest) : null;
      // A manifest job's package table lives in its stats, so it survives a
      // reload the same way the banner does — and it is the only place the user
      // can see what happened to the categories DAMC only kept.
      //
      // Not while a settled session is on screen, though. A finished session is the
      // answer for that export; a stale server-download attempt restored underneath
      // it just adds an older, worse answer to the same question.
      if (!view.manifestJob && !belongsToSession(newest, view.session)) {
        const manifestJob = lastManifestJob(recent.data);
        if (manifestJob && ['completed', 'partial', 'failed'].includes(manifestJob.status)) {
          view.manifestJob = manifestJob;
          view.manifestJobId = manifestJob.id;
        }
      }
    }

    async function copyCommand(command) {
      try {
        await navigator.clipboard.writeText(command);
        toast(t('import.cliCopied'), 'good');
      } catch {
        toast(command, 'info');
      }
    }

    /** The outcome to show: a live result wins over one restored from a job row. */
    const currentOutcome = () =>
      outcomeFromResult(view.result, { provider: view.provider, preview: view.preview, finishedAt: view.finishedAt }) ?? view.restored ?? null;

    // `arrow` marks a state that is waiting on the user rather than on DAMC. It
    // must not fall back to the check mark: a session waiting for five downloads
    // with a tick beside it reads as finished.
    const MARKS = { check: '&#10003;', cross: '&#10007;', warn: '&#9888;', arrow: '&#8594;' };

    /**
     * The completion banner: a clear, separately-titled answer to "did it work".
     * Four visually distinct states — see bannerState in import-outcome.js.
     */
    const resultBanner = () => {
      if (view.error) {
        return `<div class="notice bad result-banner" role="alert">
          <div class="result-banner-head">
            <span class="result-banner-mark" aria-hidden="true">${MARKS.cross}</span>
            <span class="result-banner-title">${esc(t('import.failedTitle'))}</span>
            ${badge('failed')}
          </div>
          <p class="result-banner-sub">${esc(errorText(view.error))}</p>
          <p class="result-banner-sub"><b>${esc(t('import.errorAction'))}:</b> ${esc(t(errorActionKey(view.error)))}</p>
        </div>`;
      }

      const o = currentOutcome();
      const banner = bannerState(o);
      if (!banner) return '';

      const summary = banner.summaryKey
        ? t(banner.summaryKey, banner.summaryParams)
        : (o.errorMessage ?? t('import.errorActionRetry'));

      const meta = [
        `${esc(t('import.statProvider'))}: ${esc(o.provider ?? '—')}`,
        o.fileName ? esc(o.fileName) : null,
        o.fileBytes ? esc(bytes(o.fileBytes)) : null,
        o.shardCount > 1 ? `${esc(t('import.statShards'))}: ${num(o.shardCount)}` : null,
        // Every count the import actually produced. Null means the server did not
        // report it (an older job row), and then the field is simply not shown —
        // never a zero standing in for "unknown".
        o.detected != null ? `${esc(t('import.metaConversations'))}: ${num(o.detected)}` : null,
        o.messages != null ? `${esc(t('import.metaMessages'))}: ${num(o.messages)}` : null,
        o.imported != null ? `${esc(t('import.metaImported'))}: ${num(o.imported)}` : null,
        o.deduplicated != null ? `${esc(t('import.metaDeduplicated'))}: ${num(o.deduplicated)}` : null,
        o.memoriesCreated != null ? `${esc(t('import.metaMemories'))}: ${num(o.memoriesCreated)}` : null,
        o.decisions != null ? `${esc(t('import.metaDecisions'))}: ${num(o.decisions)}` : null,
        o.tasks != null ? `${esc(t('import.metaTasks'))}: ${num(o.tasks)}` : null,
        o.projects != null ? `${esc(t('import.metaProjects'))}: ${num(o.projects)}` : null,
        o.finishedAt ? `${esc(t('import.finishedAt'))}: ${esc(dateTime(o.finishedAt))}` : null
      ].filter(Boolean);

      return `<div class="notice ${banner.tone} result-banner" role="status" aria-live="polite">
        <div class="result-banner-head">
          <span class="result-banner-mark" aria-hidden="true">${MARKS[banner.mark]}</span>
          <span class="result-banner-title">${esc(t(banner.titleKey))}</span>
          ${badge(o.status)}
        </div>
        <p class="result-banner-sub">${esc(summary)}</p>
        ${meta.length ? `<div class="result-banner-meta">${meta.map(m => `<span>${m}</span>`).join('')}</div>` : ''}
        ${o.restored ? `<p class="result-banner-sub dim">${esc(t('import.restoredNote'))}</p>` : ''}
      </div>`;
    };

    /**
     * Live progress while the upload is in flight.
     *
     * A percentage needs a denominator, and the conversation total is not known
     * until the export has been read to the end. Two honest sources, in order:
     * the preview's count when one was taken (the normal flow — selecting a file
     * previews it automatically), otherwise shard completion. When neither is
     * available the bar stays indeterminate and only the counts are shown, rather
     * than inventing a percentage.
     */
    const progressBlock = () => {
      if (view.busy !== 'import' && !view.justFinished) return '';
      const p = view.progress;

      if (view.justFinished) {
        return `<div class="progress"><div class="progress-bar determinate complete" style="width:100%"></div></div>
          <div class="progress-line"><span>${esc(t('import.progressPercent', { percent: '100' }))}</span></div>`;
      }
      if (!p) {
        return `<div class="progress" role="status" aria-live="polite"><div class="progress-bar"></div></div>
          <p class="row-sub">${esc(t('import.progressStarting'))}</p>`;
      }

      const percent = progressPercent(p, view.preview?.conversations ?? 0);

      const parts = [
        percent === null ? null : t('import.progressPercent', { percent: String(percent) }),
        t('import.progressConversations', { processed: num(p.processed, '0') }),
        p.shardsTotal > 1 ? t('import.progressShard', { current: num(p.shardsProcessed + 1), total: num(p.shardsTotal) }) : null
      ].filter(Boolean);

      return `<div class="progress" role="status" aria-live="polite">
          <div class="progress-bar${percent === null ? '' : ' determinate'}"${percent === null ? '' : ` style="width:${percent}%"`}></div>
        </div>
        <div class="progress-line">${parts.map(x => `<span>${esc(x)}</span>`).join('')}</div>`;
    };

    const resultCard = () => {
      const o = currentOutcome();
      if (!o) return '';
      return `<section class="card" aria-label="${attr(t('import.resultLabel'))}">
        ${sectionTitle(t('import.resultSectionTitle'), badge(o.status))}
        <div class="stat-row">
          ${statTile(t('import.importedConversations'), o.imported ?? 0)}
          ${statTile(t('import.skipped'), o.deduplicated ?? 0)}
          ${statTile(t('import.conversations'), o.detected ?? 0)}
          ${o.messages === null ? '' : statTile(t('import.statMessages'), o.messages)}
          ${statTile(t('import.memoriesCreated'), o.memoriesCreated ?? 0)}
          ${statTile(t('import.superseded'), o.superseded ?? 0)}
          ${o.decisions === null ? '' : statTile(t('import.statDecisions'), o.decisions)}
          ${o.tasks === null ? '' : statTile(t('import.statTasks'), o.tasks)}
        </div>
        <p class="row-sub mt">${esc(t('import.jobLine', { job: o.jobId ?? '—', file: o.fileName ?? '—' }))}</p>
        ${o.errors.length ? `<ul class="row-list compact mt">${o.errors.slice(0, 5).map(e => `<li class="row"><div class="row-main"><p class="row-sub">${esc(e.conversation)} — ${esc(e.message)}</p></div></li>`).join('')}</ul>` : ''}
        <div class="btn-row mt">
          <button type="button" class="btn" data-goto="memory">${esc(t('import.viewMemories'))}</button>
          <button type="button" class="btn" data-goto="sync">${esc(t('import.viewSync'))}</button>
        </div>
      </section>`;
    };

    /**
     * "Claude 내보내기 패키지를 발견했습니다" — the manifest, described.
     *
     * Shown instead of the conversation preview, because a manifest contains no
     * conversations: it is a list of packages behind links that each work once.
     * Nothing here has touched a link, and the card says so — the download only
     * starts on the button.
     */
    const manifestCard = () => {
      const m = view.manifest;
      if (!m) return '';
      const running = view.busy === 'manifest';
      // Once a session exists for *this* manifest the card's job is done: the
      // package list below is the live thing, and leaving a "start" button beside it
      // invites a second session that would supersede the packages already fetched.
      const linked = Boolean(view.session
        && manifestMatchesSession((view.manifest?.categories ?? []).map(c => c.filename), view.session));
      const meta = [
        m.version ? `${esc(t('claude.manifestVersion'))}: ${esc(m.version)}` : null,
        m.createdAt ? `${esc(t('claude.manifestCreated'))}: ${esc(dateTime(m.createdAt))}` : null,
        `${esc(t('claude.manifestFiles'))}: ${num(m.totalFiles ?? m.declaredFiles ?? 0)}`
      ].filter(Boolean);

      return `<section class="card" aria-label="${attr(t('claude.manifestFound'))}">
        ${sectionTitle(t('claude.manifestFound'), `<span class="chip chip-available">${esc(t('import.previewBadge'))}</span>`)}
        <p class="row-sub">${esc(t('claude.manifestFoundBody', { count: num(m.declaredFiles ?? m.totalFiles ?? 0) }))}</p>
        <div class="result-banner-meta">${meta.map(x => `<span>${x}</span>`).join('')}</div>
        <div class="table-scroll mt">
          <table class="table">
            <thead><tr>
              <th scope="col">${esc(t('claude.colCategory'))}</th>
              <th scope="col">${esc(t('claude.colFile'))}</th>
              <th scope="col">${esc(t('claude.colResult'))}</th>
            </tr></thead>
            <tbody>${(m.categories ?? []).map(c => `
              <tr>
                <td>${esc(c.category)}</td>
                <td>${esc(c.filename)}</td>
                <td>${c.alreadyUsed
                  ? `${badge(t('claude.fileAlreadyUsed'), 'warn')} <span class="row-sub">${esc(t('claude.fileAlreadyUsedNote'))}</span>`
                  : `<span class="row-sub">${esc(t(c.disposition === 'import' ? 'claude.categoryConversations' : c.supported ? 'claude.categoryRetained' : 'claude.categoryUnknown'))}</span>`}</td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
        <p class="row-sub dim mt">${esc(t('claude.manifestOnce'))}</p>
        <p class="row-sub dim">${esc(t('claude.manifestPreviewSafe'))}</p>
        ${linked ? (view.reattached ? `<p class="row-sub">${esc(t('claude.reattachedNote'))}</p>` : '') : `
          <p class="row-sub">${esc(t('claude.startSessionHint'))}</p>
          <div class="btn-row mt">
            <button type="button" class="btn primary" id="btn-session-start"${view.busy || api.isDemo() ? ' disabled' : ''}>
              ${esc(view.busy === 'session' ? t('claude.sessionStarting') : t('claude.startSession'))}
            </button>
          </div>
          <p class="row-sub dim mt">${esc(t('claude.autoTryHint'))}</p>
          <div class="btn-row">
            <button type="button" class="btn small" id="btn-manifest-import"${running || view.busy || api.isDemo() ? ' disabled' : ''}>
              ${esc(running ? t('claude.manifestRunning') : t('claude.autoTry'))}
            </button>
          </div>`}
      </section>`;
    };

    /** The watch folder, stated where the user is about to need it. */
    const folderBlock = () => {
      const w = view.sessionWatcher ?? watcher.data;
      if (!w) return '';
      const dir = w.hostDir ?? w.dir;
      return `<div class="notice ${w.running ? 'good' : 'warn'}">
        <p class="row-title">${esc(t('claude.folderTitle'))}</p>
        <p class="row-sub">${esc(t('claude.folderBody', { dir }))}</p>
        ${w.running
          ? `<p class="row-sub">${badge(t('claude.watcherOn'), 'good')}</p>`
          : `<p class="row-sub warn-text">${esc(t('claude.watcherOff'))}</p>`}
        <div class="btn-row mt">
          <a class="btn small" href="file:///${encodeURI(String(dir).replace(/\\/g, '/'))}" target="_blank" rel="noopener">${esc(t('claude.folderOpen'))}</a>
          ${w.running ? '' : `<button type="button" class="btn primary small" id="btn-session-watch">${esc(t('claude.watcherStart'))}</button>`}
        </div>
      </div>`;
    };

    /**
     * The package list: what the user acts on.
     *
     * Every package is accounted for on its own row — position, filename, state and
     * either the one action that is its turn or the reason there is none. One button
     * is live at a time; see packageAction in import-outcome.js for why.
     */
    const packageSessionCard = () => {
      const session = view.session;
      if (!session) return '';
      const packages = session.packages ?? [];
      const p = sessionProgress(session);
      const banner = sessionBanner(session);
      const anyMissingUrl = packages.some(pkg =>
        packageAction(pkg, packages, view.packageUrls?.has(normalizePackageName(pkg.filename))) === 'needs-manifest');

      const row = pkg => {
        const hasUrl = Boolean(view.packageUrls?.has(normalizePackageName(pkg.filename)));
        const action = packageAction(pkg, packages, hasUrl);
        const labels = { download: 'claude.browserDownload', reopen: 'claude.browserReopen', redownload: 'claude.browserRedownload' };
        const side = labels[action]
          ? `<button type="button" class="btn ${action === 'download' ? 'primary ' : ''}small" data-package="${attr(pkg.id)}">${esc(t(labels[action]))}</button>`
          : action === 'queued' ? `<span class="row-sub dim">${esc(t('claude.browserQueued'))}</span>`
            : action === 'needs-manifest' ? `<span class="row-sub dim">${esc(t('claude.needsManifest'))}</span>`
              : '';
        const failure = pkg.status === 'failed'
          ? (packageErrorKey(pkg.errorCode) ? t(packageErrorKey(pkg.errorCode)) : pkg.errorMessage)
          : null;
        const detail = failure ? failure
          : pkg.status === 'retained' ? `${t('claude.categoryKeptNote')}${pkg.entryCount ? ` · ${num(pkg.entryCount)}${t('claude.summaryEntries')}` : ''}`
            : pkg.status === 'imported' && pkg.stats
              ? t('import.doneSummary', {
                imported: num(pkg.stats.imported ?? 0, '0'),
                detected: num(pkg.stats.conversations ?? 0, '0'),
                memories: num(pkg.stats.memoriesCreated ?? 0, '0')
              })
              : '';
        return `<li class="row">
          <div class="row-main">
            <p class="row-title">[${num(pkg.sequence)}/${num(p.total)}] ${esc(pkg.filename)}</p>
            <p class="row-sub">${badge(t(packageStatusLabelKey(pkg.status)), packageStatusTone(pkg.status))}
              <span>${esc(pkg.category)}</span>${pkg.bytes ? ` · <span>${esc(bytes(pkg.bytes))}</span>` : ''}</p>
            ${detail ? `<p class="row-sub dim">${esc(detail)}</p>` : ''}
          </div>
          <div class="row-side">${side}</div>
        </li>`;
      };

      return `<section class="card" aria-label="${attr(t('claude.deliveryTitle'))}">
        ${sectionTitle(t('claude.deliveryTitle'), badge(session.status))}
        ${banner ? `<div class="notice ${banner.tone} result-banner" role="status" aria-live="polite">
          <div class="result-banner-head">
            <span class="result-banner-mark" aria-hidden="true">${MARKS[banner.mark] ?? MARKS.check}</span>
            <span class="result-banner-title">${esc(t(banner.titleKey))}</span>
          </div>
          <p class="result-banner-sub">${esc(t(banner.summaryKey, banner.summaryParams))}</p>
        </div>` : ''}
        ${folderBlock()}
        <div class="progress" role="status" aria-live="polite">
          <div class="progress-bar${p.percent === null ? '' : ' determinate'}${p.percent === 100 ? ' complete' : ''}"${p.percent === null ? '' : ` style="width:${p.percent}%"`}></div>
        </div>
        <div class="progress-line">
          ${p.percent === null ? '' : `<span>${esc(t('import.progressPercent', { percent: String(p.percent) }))}</span>`}
          <span>${esc(t('claude.progressFiles', { done: num(p.done, '0'), total: num(p.total, '0') }))}</span>
        </div>
        <ul class="row-list">${packages.map(row).join('')}</ul>
        ${anyMissingUrl ? `<p class="row-sub dim mt">${esc(t('claude.urlLostNote'))}</p>` : ''}
        ${packages.some(pkg => pkg.status === 'opened') ? `<p class="row-sub dim">${esc(t('claude.browserQueuedHint'))}</p>` : ''}
      </section>`;
    };

    /**
     * What the export actually added, once every package is accounted for.
     *
     * Per category, and honest about the difference between the two kinds of number:
     * a parsed category reports conversations and memories, a kept one reports the
     * archive and how many entries were observed inside it. An entry count is not a
     * count of projects or of memories, and is not labelled as one.
     */
    const sessionSummaryCard = () => {
      const session = view.session;
      if (!session || session.status === 'awaiting_download') return '';
      return `<section class="card" aria-label="${attr(t('claude.summaryTitle'))}">
        ${sectionTitle(t('claude.summaryTitle'), badge(session.status))}
        <div class="stat-row">
          ${statTile(t('claude.summaryConversations'), session.conversations ?? 0)}
          ${statTile(t('claude.summaryMessages'), session.messages ?? 0)}
          ${statTile(t('claude.summaryMemories'), session.memoriesCreated ?? 0)}
          ${statTile(t('import.skipped'), session.deduplicated ?? 0)}
          ${statTile(t('claude.summaryKept'), session.retainedArchives ?? 0)}
        </div>
        <ul class="row-list compact mt">${(session.byCategory ?? []).map(c => `
          <li class="row">
            <div class="row-main">
              <p class="row-title">${esc(c.category)}</p>
              <p class="row-sub">${c.disposition === 'import'
                ? esc(t('import.doneSummary', {
                  imported: num(c.conversations ?? 0, '0'),
                  detected: num(c.conversations ?? 0, '0'),
                  memories: num(c.memoriesCreated ?? 0, '0')
                }))
                : `${esc(t('claude.categoryKeptNote'))}${c.entries ? ` · ${num(c.entries)}${esc(t('claude.summaryEntries'))}` : ''}`}</p>
            </div>
            <div class="row-side">${badge(t(packageStatusLabelKey(c.status)), packageStatusTone(c.status))}</div>
          </li>`).join('')}</ul>
      </section>`;
    };

    /**
     * Per-package state while a manifest job runs, and after it finishes.
     *
     * Every package is accounted for — imported, kept, link already used, blocked
     * or failed — because a manifest import that only reported the conversations
     * would leave the user guessing about the other four files.
     */
    const manifestJobCard = () => {
      const job = view.manifestJob;
      const stats = job?.stats;
      if (!stats || stats.mode !== 'manifest') return '';
      const p = manifestProgress(stats, view.progress);
      const running = view.busy === 'manifest';

      const blocked = p.blockedByChallenge ? `<div class="notice bad result-banner" role="alert">
          <div class="result-banner-head">
            <span class="result-banner-mark" aria-hidden="true">${MARKS.cross}</span>
            <span class="result-banner-title">${esc(t('claude.blockedTitle'))}</span>
          </div>
          <p class="result-banner-sub">${esc(t('claude.blockedBody'))}</p>
          <p class="result-banner-sub"><b>${esc(t('import.errorAction'))}:</b> ${esc(t('claude.blockedAction'))}</p>
        </div>` : '';

      const retained = (stats.files ?? []).filter(f => f.status === 'retained');

      return `<section class="card" aria-label="${attr(t('claude.manifestFiles'))}">
        ${sectionTitle(t('claude.manifestFiles'), badge(job.status))}
        ${blocked}
        ${running || p.percent !== null ? `<div class="progress" role="status" aria-live="polite">
            <div class="progress-bar${p.percent === null ? '' : ' determinate'}${!running && p.percent === 100 ? ' complete' : ''}"${p.percent === null ? '' : ` style="width:${p.percent}%"`}></div>
          </div>
          <div class="progress-line">
            ${p.percent === null ? '' : `<span>${esc(t('import.progressPercent', { percent: String(p.percent) }))}</span>`}
            <span>${esc(t('claude.progressFiles', { done: num(p.done, '0'), total: num(p.total, '0') }))}</span>
            ${p.category ? `<span>${esc(t('claude.progressCategory', { category: p.category }))}</span>` : ''}
          </div>` : ''}
        <div class="table-scroll mt">
          <table class="table">
            <thead><tr>
              <th scope="col">${esc(t('claude.colCategory'))}</th>
              <th scope="col">${esc(t('claude.colFile'))}</th>
              <th scope="col">${esc(t('claude.colState'))}</th>
              <th scope="col">${esc(t('claude.colResult'))}</th>
            </tr></thead>
            <tbody>${(stats.files ?? []).map(f => `
              <tr class="${f.status === 'failed' || f.status === 'blocked' ? 'row-bad' : ''}">
                <td>${esc(f.category)}</td>
                <td>${esc(f.filename)}${f.bytes ? `<br><span class="row-sub">${esc(bytes(f.bytes))}</span>` : ''}</td>
                <td>${badge(t(manifestFileLabelKey(f.status)), manifestFileTone(f.status))}</td>
                <td>${manifestFileResult(f)}</td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
        ${retained.length ? `<p class="row-sub dim mt">${esc(t('claude.retainedNote', { count: num(retained.length), job: job.id }))}</p>` : ''}
      </section>`;
    };

    /** The right-hand cell of the package table: what actually happened to it. */
    function manifestFileResult(file) {
      if (file.status === 'imported') {
        return esc(t('import.doneSummary', {
          imported: num(file.imported ?? 0, '0'),
          detected: num(file.conversations ?? 0, '0'),
          memories: num(file.memoriesCreated ?? 0, '0')
        }));
      }
      if (file.status === 'retained') {
        // The observed entry names, not a guess at what they mean.
        const names = (file.entryNames ?? []).slice(0, 4).join(', ');
        return `<span class="row-sub">${esc(t('claude.categoryRetained'))}</span>`
          + (names ? `<br><span class="row-sub dim">${esc(t('claude.entriesObserved'))}: ${esc(names)}${(file.entryCount ?? 0) > 4 ? ' …' : ''}</span>` : '');
      }
      // Known conditions get the localised sentence; the server's own message is
      // the fallback for anything this page does not recognise, rather than
      // showing an English sentence under a Korean heading.
      const known = {
        already_used: 'claude.fileAlreadyUsedNote',
        blocked: 'claude.fileBlockedNote',
        skipped: 'claude.fileSkippedNote'
      }[file.status];
      if (known) return `<span class="row-sub">${esc(t(known))}</span>`;
      if (file.errorMessage) return `<span class="row-sub">${esc(file.errorMessage)}</span>`;
      return '<span class="row-sub dim">—</span>';
    }

    const previewCard = () => {
      if (view.busy === 'preview') {
        return `<section class="card"><div class="state-block" role="status"><span class="spinner"></span><p>${esc(t('import.parsing'))}</p></div></section>`;
      }
      if (!view.preview) return '';
      const p = view.preview;
      return `<section class="card" aria-label="${attr(t('import.previewLabel'))}">
        ${sectionTitle(t('import.previewSectionTitle'), `<span class="chip chip-available">${esc(t('import.previewBadge'))}</span>`)}
        <p class="row-sub">${esc(t('import.previewSectionHint'))}</p>
        <div class="stat-row">
          <div class="stat"><div class="stat-label">${esc(t('import.conversations'))}</div><div class="stat-num">${num(p.conversations, '0')}</div></div>
          <div class="stat"><div class="stat-label">${esc(t('import.messages'))}</div><div class="stat-num">${num(p.messages, '0')}</div></div>
          <div class="stat"><div class="stat-label">${esc(t('import.fileSize'))}</div><div class="stat-num">${esc(bytes(p.fileBytes))}</div></div>
        </div>
        ${(p.sampleTitles ?? []).length ? `<p class="row-sub mt">${esc(t('import.firstConversations'))}</p>
          <ul class="row-list compact">${p.sampleTitles.map(title => `<li class="row"><div class="row-main"><p class="row-sub">${esc(title)}</p></div></li>`).join('')}</ul>` : ''}
      </section>`;
    };

    const autoImportCard = () => {
      const w = watcher.data;
      const running = Boolean(w?.running);
      return `<section class="card" aria-label="${attr(t('import.autoTitle'))}">
        ${sectionTitle(t('import.autoTitle'), w ? badge(running ? 'watching' : 'stopped', running ? 'good' : 'muted') : '')}
        ${region(watcher, w => `
          <p class="row-sub">${esc(t('import.autoDir'))} <code>${esc(w.hostDir ?? w.dir)}</code></p>
          <p class="row-title mt">${running ? esc(t('import.autoRunning')) : esc(t('import.autoStopped'))}</p>
          ${!w.dirExists && !running ? `<p class="row-sub dim">${esc(t('import.autoFolderMissing'))}</p>` : ''}
          <div class="btn-row mt">
            <a class="btn small" href="file:///${encodeURI((w.hostDir ?? w.dir).replace(/\\/g, '/'))}" target="_blank" rel="noopener">${esc(t('import.autoOpenFolder'))}</a>
            <button type="button" class="btn primary small" id="btn-watch-toggle"${api.isDemo() ? ' disabled' : ''}>${esc(running ? t('import.autoStop') : t('import.autoStart'))}</button>
          </div>
          ${api.isDemo() ? `<p class="row-sub warn-text mt">${esc(t('import.autoDemo'))}</p>` : ''}
          <p class="row-sub dim mt">${esc(t('import.autoHint'))}</p>
          ${w.lastEvent ? `<p class="row-sub mt"><b>${esc(t('import.autoLastEvent'))}:</b> ${badge(w.lastEvent.status)} ${esc(w.lastEvent.file)}${w.lastEvent.reason ? ` — ${esc(w.lastEvent.reason)}` : ''}</p>`
            : `<p class="row-sub dim mt">${esc(t('import.autoNone'))}</p>`}
        `, { loading: t('sync.loading'), retry: 'reload-watch', empty: t('import.autoStatusFailed'), emptyHint: '' })}
      </section>`;
    };

    const cliImportCard = () => {
      const provider = PROVIDERS.find(p => p.id === view.provider) ?? PROVIDERS[0];
      const command = cliCommand(provider.id, view.file?.name ? `C:\\path\\to\\${view.file.name}` : 'C:\\path\\to\\export.json');
      return `<section class="card" aria-label="${attr(t('import.cliTitle'))}">
        ${sectionTitle(t('import.cliTitle'))}
        <p class="row-sub">${esc(t('import.cliBody'))}</p>
        <pre class="code-block" id="cli-command">${esc(command)}</pre>
        <div class="btn-row">
          <button type="button" class="btn small" id="btn-copy-cli">${esc(t('import.cliCopy'))}</button>
        </div>
      </section>`;
    };

    const recentImportsCard = () => `<section class="card" aria-label="${attr(t('import.recentTitle'))}">
        ${sectionTitle(t('import.recentTitle'), `<button type="button" class="btn small" data-goto="sync">${esc(t('import.recentViewAll'))}</button>`)}
        ${region(recent, jobs => jobs.length ? `
          <div class="table-scroll">
            <table class="table">
              <thead><tr>
                <th scope="col">${esc(t('sync.colProvider'))}</th><th scope="col">${esc(t('sync.colStatus'))}</th>
                <th scope="col">${esc(t('sync.colStarted'))}</th><th scope="col">${esc(t('sync.colImported'))}</th>
                <th scope="col">${esc(t('sync.colSkipped'))}</th><th scope="col">${esc(t('sync.colMemories'))}</th>
              </tr></thead>
              <tbody>${jobs.map(j => `
                <tr class="${j.status === 'failed' ? 'row-bad' : ''}">
                  <td>${esc(j.connector)}</td>
                  <td>${badge(j.status)}</td>
                  <td title="${esc(dateTime(j.startedAt))}">${esc(j.startedAt ? relative(j.startedAt) : '—')}</td>
                  <td>${num(j.stats?.imported, '0')}</td>
                  <td>${num(j.stats?.deduplicated, '0')}</td>
                  <td>${num(j.stats?.memoriesCreated, '0')}</td>
                </tr>`).join('')}</tbody>
            </table>
          </div>` : `<p class="row-sub dim">${esc(t('import.recentEmpty'))}</p>`,
        { loading: t('sync.loading'), retry: 'reload-recent', empty: t('import.recentEmpty'), emptyHint: '' })}
      </section>`;

    const paint = () => {
      const provider = PROVIDERS.find(p => p.id === view.provider) ?? PROVIDERS[0];
      root.innerHTML = `
        <div class="import-layout">
          <section class="card" aria-label="${attr(t('import.chooseLabel'))}">
            ${sectionTitle(t('import.step1'))}
            <div class="btn-row" role="group" aria-label="${attr(t('import.providerGroup'))}">
              ${PROVIDERS.map(p => `<button type="button" class="btn${p.id === view.provider ? ' primary' : ''}" data-provider="${attr(p.id)}" aria-pressed="${p.id === view.provider}">${esc(p.label)}</button>`).join('')}
            </div>
            <p class="row-sub mt">${esc(t(provider.hint))}</p>

            ${sectionTitle(t('import.step2'))}
            <div class="drop" id="drop" tabindex="0" role="button" aria-label="${attr(t('import.dropAria'))}">
              <strong>${esc(t('import.dropTitle'))}</strong>
              <span>${esc(t('import.dropHint'))}</span>
              <input id="file-input" type="file" accept=".json,.zip,application/json,application/zip" hidden>
            </div>
            ${view.file ? `<div class="file-info">
              <div>
                <p class="row-title">${esc(view.file.name)}</p>
                <p class="row-sub">${esc(bytes(view.file.size))} · provider ${esc(view.provider)}</p>
              </div>
              <button type="button" class="btn small" id="clear-file">${esc(t('import.remove'))}</button>
            </div>` : `<p class="row-sub mt">${esc(t('import.noFile'))}</p>`}

            ${sectionTitle(t('import.step3'))}
            <div class="btn-row">
              <button type="button" class="btn" id="btn-preview"${!view.file || view.busy ? ' disabled' : ''}>${esc(t('import.previewOnly'))}</button>
              ${view.manifest ? '' : `<button type="button" class="btn primary" id="btn-import"${!view.file || view.busy ? ' disabled' : ''}>
                ${esc(view.busy === 'import' ? t('import.running') : t('import.run'))}
              </button>`}
            </div>
            ${progressBlock()}
            ${view.busy === 'import' && !view.progress ? `<p class="row-sub">${esc(t('import.progress'))}</p>` : ''}
            ${api.isDemo() ? `<p class="row-sub warn-text mt">${esc(t('import.demo'))}</p>` : ''}
            ${resultBanner()}
          </section>

          <section class="card" aria-label="${attr(t('import.pipelineLabel'))}">
            ${sectionTitle(t('import.pipeline'))}
            <ol class="pipeline">
              <li><b>${esc(t('import.step.parse'))}</b><span>${esc(t('import.step.parseBody'))}</span></li>
              <li><b>${esc(t('import.step.normalize'))}</b><span>${esc(t('import.step.normalizeBody'))}</span></li>
              <li><b>${esc(t('import.step.dedupe'))}</b><span>${esc(t('import.step.dedupeBody'))}</span></li>
              <li><b>${esc(t('import.step.extract'))}</b><span>${esc(t('import.step.extractBody'))}</span></li>
              <li><b>${esc(t('import.step.supersede'))}</b><span>${esc(t('import.step.supersedeBody'))}</span></li>
            </ol>
            <p class="row-sub dim mt">${esc(t('import.idempotent'))}</p>
          </section>

          ${autoImportCard()}
          ${cliImportCard()}
        </div>
        ${manifestCard()}
        ${packageSessionCard()}
        ${sessionSummaryCard()}
        ${manifestJobCard()}
        ${resultCard()}
        ${previewCard()}
        ${recentImportsCard()}`;
      wire();
    };

    const wire = () => {
      root.querySelectorAll('[data-provider]').forEach(btn => btn.addEventListener('click', () => {
        view.provider = btn.dataset.provider;
        view.preview = null; view.result = null; view.error = null; view.restored = null;
        view.manifest = null; view.manifestJob = null; view.manifestJobId = null;
        paint();
        if (view.file && !api.isDemo()) preview();
      }));

      const input = root.querySelector('#file-input');
      const drop = root.querySelector('#drop');
      drop?.addEventListener('click', () => input?.click());
      drop?.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input?.click(); } });
      input?.addEventListener('change', e => setFile(e.target.files?.[0]));
      ['dragenter', 'dragover'].forEach(type => drop?.addEventListener(type, e => { e.preventDefault(); drop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach(type => drop?.addEventListener(type, e => { e.preventDefault(); drop.classList.remove('over'); }));
      drop?.addEventListener('drop', e => setFile(e.dataTransfer?.files?.[0]));

      root.querySelector('#clear-file')?.addEventListener('click', () => setFile(null));
      root.querySelector('#btn-preview')?.addEventListener('click', preview);
      root.querySelector('#btn-import')?.addEventListener('click', runImport);
      root.querySelector('#btn-manifest-import')?.addEventListener('click', runManifestImport);
      root.querySelector('#btn-session-start')?.addEventListener('click', startPackageSession);
      // Start, never toggle. It is rendered from view.sessionWatcher while
      // toggleWatcher decides from the other copy of that state, so a toggle here
      // could stop the watcher the button offered to start.
      root.querySelector('#btn-session-watch')?.addEventListener('click', async () => {
        try {
          watcher = ready(await api.startWatcher());
          toast(t('claude.watcherOn'), 'good');
        } catch (error) {
          toast(error.message, 'bad');
        }
        await loadSession();
        paint();
      });
      root.querySelectorAll('[data-package]').forEach(btn => btn.addEventListener('click', () => {
        const pkg = (view.session?.packages ?? []).find(p => p.id === btn.dataset.package);
        if (pkg) downloadPackage(pkg);
      }));
      root.querySelector('#btn-watch-toggle')?.addEventListener('click', toggleWatcher);
      root.querySelector('#btn-copy-cli')?.addEventListener('click', () => copyCommand(root.querySelector('#cli-command')?.textContent ?? ''));
      root.querySelector('[data-action="reload-watch"]')?.addEventListener('click', loadWatcher);
      root.querySelector('[data-action="reload-recent"]')?.addEventListener('click', loadRecent);
      root.querySelectorAll('[data-goto]').forEach(btn => btn.addEventListener('click', () => { location.hash = `#/${btn.dataset.goto}`; }));
    };

    paint();
    // The session is loaded FIRST, not alongside the others. restoreLastOutcome runs
    // inside loadRecent and asks whether a settled session is already answering for
    // this export; racing them meant it sometimes saw no session and restored a
    // duplicate result card underneath the session's own summary.
    await loadSession();
    await Promise.all([loadWatcher(), loadRecent()]);
    // A session waits on a human, so it is normally still open when the page is
    // reopened. Resume following it rather than making the user re-select anything.
    if (view.session?.status === 'awaiting_download') startSessionPolling();
    paint();
  }
};
