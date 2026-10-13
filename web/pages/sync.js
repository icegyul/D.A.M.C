import * as api from '../api.js';
import { idle, loading, ready, failed } from '../state.js';
import { esc, badge, region, num, dateTime, relative } from '../ui.js';
import { t } from '../i18n.js';

function duration(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return '—';
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return t('sync.minutes', { n: Math.round(ms / 60000) });
}

export default {
  id: 'sync',

  async mount(root) {
    let result = idle();

    async function load() {
      result = loading(); paint();
      try { result = ready(await api.getSyncJobs(50)); } catch (e) { result = failed(e); }
      paint();
    }

    const paint = () => {
      root.innerHTML = `
        <div class="toolbar">
          <button type="button" class="btn" id="sync-reload">${esc(t('sync.reload'))}</button>
          <button type="button" class="btn" data-goto="import">${esc(t('sync.newImport'))}</button>
        </div>
        ${region(result, jobs => {
          const counts = jobs.reduce((acc, j) => { acc[j.status] = (acc[j.status] ?? 0) + 1; return acc; }, {});
          return `
            <div class="stat-row mb">
              <div class="stat"><div class="stat-label">${esc(t('sync.jobs'))}</div><div class="stat-num">${jobs.length}</div></div>
              <div class="stat"><div class="stat-label">${esc(t('sync.completed'))}</div><div class="stat-num">${counts.completed ?? 0}</div></div>
              <div class="stat"><div class="stat-label">${esc(t('sync.failed'))}</div><div class="stat-num">${counts.failed ?? 0}</div></div>
              <div class="stat"><div class="stat-label">${esc(t('sync.queued'))}</div><div class="stat-num">${counts.queued ?? 0}</div></div>
              <div class="stat"><div class="stat-label">${esc(t('sync.running'))}</div><div class="stat-num">${counts.running ?? 0}</div></div>
            </div>
            <section class="card">
              <div class="table-scroll">
                <table class="table">
                  <thead><tr>
                    <th scope="col">${esc(t('sync.colProvider'))}</th><th scope="col">${esc(t('sync.colType'))}</th><th scope="col">${esc(t('sync.colStatus'))}</th>
                    <th scope="col">${esc(t('sync.colStarted'))}</th><th scope="col">${esc(t('sync.colCompleted'))}</th><th scope="col">${esc(t('sync.colDuration'))}</th>
                    <th scope="col">${esc(t('sync.colImported'))}</th><th scope="col">${esc(t('sync.colSkipped'))}</th><th scope="col">${esc(t('sync.colMemories'))}</th><th scope="col">${esc(t('sync.colSuperseded'))}</th>
                  </tr></thead>
                  <tbody>${jobs.map(j => `
                    <tr class="${j.status === 'failed' ? 'row-bad' : ''}">
                      <td>${esc(j.connector)}</td>
                      <td>${esc(j.direction ?? '—')}</td>
                      <td>${badge(j.status)}</td>
                      <td title="${esc(dateTime(j.startedAt))}">${esc(j.startedAt ? relative(j.startedAt) : '—')}</td>
                      <td title="${esc(dateTime(j.finishedAt))}">${esc(j.finishedAt ? relative(j.finishedAt) : '—')}</td>
                      <td>${esc(duration(j.startedAt, j.finishedAt))}</td>
                      <td>${num(j.stats?.imported, '0')}</td>
                      <td>${num(j.stats?.deduplicated, '0')}</td>
                      <td>${num(j.stats?.memoriesCreated, '0')}</td>
                      <td>${num(j.stats?.superseded, '0')}</td>
                    </tr>
                    ${j.errorMessage ? `<tr class="row-error"><td colspan="10"><b>${esc(t('sync.error'))}</b> ${esc(j.errorMessage)}</td></tr>` : ''}
                  `).join('')}</tbody>
                </table>
              </div>
            </section>`;
        }, {
          loading: t('sync.loading'), retry: 'reload-sync',
          empty: t('sync.none'), emptyHint: t('sync.noneHint')
        })}`;
      wire();
    };

    const wire = () => {
      root.querySelector('#sync-reload')?.addEventListener('click', load);
      root.querySelector('[data-action="reload-sync"]')?.addEventListener('click', load);
      root.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => { location.hash = `#/${b.dataset.goto}`; }));
    };

    paint();
    await load();
  }
};
