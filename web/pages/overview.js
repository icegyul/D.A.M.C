import * as api from '../api.js';
import { idle, loading, ready, failed } from '../state.js';
import { esc, attr, badge, num, region, statTile, sectionTitle, relative, dateTime, truncate } from '../ui.js';
import { t } from '../i18n.js';
import { state as appState } from '../state.js';

/**
 * First-run welcome. Shown only while the database is genuinely empty — no
 * memories, no conversations, no projects — and made of text and buttons only.
 * It writes nothing: the product's rule is that a fresh install has zero rows,
 * and the way to make an empty screen not look broken is to explain it.
 */
function welcomeCard() {
  return `
    <section class="card welcome span-2" aria-label="${attr(t('overview.welcomeTitle'))}">
      ${sectionTitle(t('overview.welcomeTitle'))}
      <p class="row-title">${esc(t('overview.welcomeEmpty'))}</p>
      <p class="row-sub">${esc(t('overview.welcomeWhat'))}</p>
      <ul class="welcome-steps">
        <li>${esc(t('overview.welcomeStep1'))}</li>
        <li>${esc(t('overview.welcomeStep2'))}</li>
        <li>${esc(t('overview.welcomeStep3'))}</li>
      </ul>
      <p class="row-sub dim">${esc(t('overview.welcomeObsidian'))}</p>
      <div class="btn-row">
        <button type="button" class="btn small primary" data-welcome="import:chatgpt">${esc(t('overview.btnImportChatgpt'))}</button>
        <button type="button" class="btn small primary" data-welcome="import:claude">${esc(t('overview.btnImportClaude'))}</button>
        <button type="button" class="btn small" data-welcome="connections">${esc(t('overview.btnConnectAi'))}</button>
        <button type="button" class="btn small" data-welcome="obsidian">${esc(t('overview.btnObsidian'))}</button>
      </div>
    </section>`;
}

const STATE_SECTIONS = [
  ['goals', 'state.goals'], ['decisions', 'state.decisions'], ['rules', 'state.rules'],
  ['constraints', 'state.constraints'], ['openIssues', 'state.openIssues'], ['tasks', 'state.tasks']
];

export default {
  id: 'overview',

  async mount(root) {
    root.addEventListener('click', e => {
      const btn = e.target.closest('[data-welcome]');
      if (!btn) return;
      const [page, provider] = btn.dataset.welcome.split(':');
      if (provider) appState.importer.provider = provider;
      location.hash = `#/${page}`;
    });
    let dashboard = idle();
    let recent = idle();
    let current = idle();

    const paint = () => {
      const totals = dashboard.status === 'ready' ? dashboard.data : null;
      const fresh = !!totals && !(totals.memory?.total) && !(totals.conversations?.total) && !(totals.projects?.total);
      root.innerHTML = `
        <div class="grid-2col">
          ${fresh ? welcomeCard() : ''}
          <section class="card span-2" aria-label="${attr(t('overview.stats'))}">
            ${region(dashboard, d => `
              <div class="stat-row">
                ${statTile(t('overview.totalMemories'), d.memory?.total)}
                ${statTile(t('overview.active'), d.memory?.active)}
                ${statTile(t('overview.candidate'), d.memory?.candidates)}
                ${statTile(t('overview.superseded'), d.memory?.superseded)}
                ${statTile(t('overview.projects'), d.projects?.total)}
                ${statTile(t('overview.relations'), d.relations?.total)}
                ${statTile(t('overview.conversations'), d.conversations?.total, t('overview.providers', { n: num(d.conversations?.providers, '0') }))}
              </div>`, { loading: t('overview.loadingDashboard'), retry: 'reload-dashboard', empty: t('overview.noCounters') })}
          </section>

          <section class="card" aria-label="${attr(t('overview.recentMemories'))}">
            ${sectionTitle(t('overview.recentMemories'), `<button type="button" class="link-btn" data-goto="memory">${esc(t('overview.openMemory'))}</button>`)}
            ${region(recent, rows => `<ul class="row-list">${rows.map(m => `
              <li class="row">
                <div class="row-main">
                  <p class="row-title">${esc(truncate(m.title, 110))}</p>
                  <p class="row-sub">${esc(m.projectName ?? t('overview.noProject'))} · ${esc(m.provider ?? t('overview.unknownSource'))} · ${esc(relative(m.updatedAt))}</p>
                </div>
                <div class="row-side">${badge(m.type, 'muted')}${badge(m.status)}</div>
              </li>`).join('')}</ul>`, {
                loading: t('overview.loadingMemories'), retry: 'reload-recent',
                empty: t('overview.noMemories'), emptyHint: t('overview.noMemoriesHint')
              })}
          </section>

          <section class="card" aria-label="${attr(t('overview.currentStateGlobal'))}">
            ${sectionTitle(t('overview.currentStateGlobal'), `<button type="button" class="link-btn" data-goto="current-state">${esc(t('overview.open'))}</button>`)}
            ${region(current, s => {
              const filled = STATE_SECTIONS.filter(([key]) => (s[key] ?? []).length);
              if (!filled.length) {
                return `<p class="state-hint">${esc(t('overview.globalEmpty'))}</p>`;
              }
              return `<ul class="row-list">${filled.map(([key, label]) => `
                <li class="row">
                  <div class="row-main">
                    <p class="row-title">${esc(t(label))}</p>
                    <p class="row-sub">${esc(truncate(s[key][0]?.title ?? '', 90))}</p>
                  </div>
                  <div class="row-side"><span class="count">${s[key].length}</span></div>
                </li>`).join('')}</ul>
                <p class="row-sub mt">${esc(t('overview.generated', { time: dateTime(s.generatedAt) }))}</p>`;
            }, { loading: t('overview.loadingState'), retry: 'reload-state', empty: t('overview.noState') })}
          </section>

          <section class="card span-2" aria-label="${attr(t('overview.recentSync'))}">
            ${sectionTitle(t('overview.recentSync'), `<button type="button" class="link-btn" data-goto="sync">${esc(t('overview.openSync'))}</button>`)}
            ${region(dashboard, d => {
              const jobs = d.recentJobs ?? [];
              if (!jobs.length) return `<p class="state-hint">${esc(t('overview.noJobs'))}</p>`;
              return `<div class="table-scroll"><table class="table">
                <thead><tr><th scope="col">${esc(t('overview.colProvider'))}</th><th scope="col">${esc(t('overview.colStatus'))}</th><th scope="col">${esc(t('overview.colImported'))}</th><th scope="col">${esc(t('overview.colMemories'))}</th><th scope="col">${esc(t('overview.colFinished'))}</th></tr></thead>
                <tbody>${jobs.map(j => `<tr>
                  <td>${esc(j.connector)}</td>
                  <td>${badge(j.status)}</td>
                  <td>${num(j.stats?.imported, '0')}</td>
                  <td>${num(j.stats?.memoriesCreated, '0')}</td>
                  <td>${esc(j.finishedAt ? dateTime(j.finishedAt) : '—')}</td>
                </tr>`).join('')}</tbody></table></div>`;
            }, { loading: t('overview.loadingSync'), retry: 'reload-dashboard' })}
          </section>
        </div>`;
      wire();
    };

    const wire = () => {
      root.querySelectorAll('[data-goto]').forEach(btn => {
        btn.addEventListener('click', () => { location.hash = `#/${btn.dataset.goto}`; });
      });
      root.querySelector('[data-action="reload-dashboard"]')?.addEventListener('click', loadDashboard);
      root.querySelector('[data-action="reload-recent"]')?.addEventListener('click', loadRecent);
      root.querySelector('[data-action="reload-state"]')?.addEventListener('click', loadState);
    };

    async function loadDashboard() {
      dashboard = loading(); paint();
      try { dashboard = ready(await api.getDashboard()); } catch (e) { dashboard = failed(e); }
      paint();
    }
    async function loadRecent() {
      recent = loading(); paint();
      try { recent = ready(await api.getMemories({ sort: 'newest', limit: 6 })); } catch (e) { recent = failed(e); }
      paint();
    }
    async function loadState() {
      current = loading(); paint();
      try { current = ready(await api.getCurrentState(undefined, { cached: true })); } catch (e) { current = failed(e); }
      paint();
    }

    paint();
    await Promise.all([loadDashboard(), loadRecent(), loadState()]);
  }
};
