import * as api from '../api.js';
import { state, idle, loading, ready, failed } from '../state.js';
import { esc, attr, badge, region, sectionTitle, dateTime, truncate, pctText, toast } from '../ui.js';
import { t } from '../i18n.js';

const SECTIONS = [
  ['goals', 'state.goals'],
  ['decisions', 'state.decisions'],
  ['rules', 'state.rules'],
  ['constraints', 'state.constraints'],
  ['openIssues', 'state.openIssues'],
  ['tasks', 'state.tasks'],
  ['insights', 'state.insights'],
  ['questions', 'state.questions'],
  ['recentKnowledge', 'state.recentKnowledge']
];

export default {
  id: 'current-state',

  async mount(root) {
    const view = state.currentState;
    let result = idle();
    let projects = idle();
    let rebuilding = false;

    async function loadProjects() {
      try { projects = ready(await api.getProjects()); } catch (e) { projects = failed(e); }
      paint();
    }

    async function loadState() {
      result = loading(); paint();
      try { result = ready(await api.getCurrentState(view.projectId || undefined, { cached: true })); }
      catch (e) { result = failed(e); }
      paint();
    }

    async function rebuild() {
      rebuilding = true; paint();
      try {
        const fresh = await api.rebuildCurrentState(view.projectId || undefined);
        result = ready(fresh);
        toast(t('state.rebuilt'), 'good');
      } catch (error) {
        toast(error.message, 'bad');
      }
      rebuilding = false;
      paint();
    }

    const scopeName = () => {
      if (!view.projectId) return t('state.globalScopeShort');
      const list = projects.status === 'ready' ? projects.data : [];
      return list.find(p => p.id === view.projectId)?.name ?? t('state.project');
    };

    const sectionCard = (key, label, items) => `
      <section class="card state-card" aria-label="${attr(label)}">
        ${sectionTitle(t(label), `<span class="count">${items.length}</span>`)}
        ${items.length
          ? `<ul class="row-list compact">${items.map(item => `
              <li class="row">
                <div class="row-main">
                  <p class="row-title">${esc(truncate(item.title, 120))}</p>
                  <p class="row-sub">${esc(truncate(item.summary ?? item.content ?? '', 150))}</p>
                  <p class="row-sub dim">conf ${esc(pctText(item.confidence))} · imp ${esc(pctText(item.importance))} · ${esc(dateTime(item.updatedAt))}</p>
                </div>
                <div class="row-side">${badge(item.status)}</div>
              </li>`).join('')}</ul>`
          : `<p class="state-hint">${esc(t('state.nothingHere'))}</p>`}
      </section>`;

    const paint = () => {
      const projectOptions = projects.status === 'ready' ? projects.data : [];
      root.innerHTML = `
        <div class="toolbar">
          <label class="field">
            <span class="sr-only">${esc(t('state.scope'))}</span>
            <select id="cs-project" aria-label="${attr(t('state.scope'))}">
              <option value="">${esc(t('state.globalScope'))}</option>
              ${projectOptions.map(p => `<option value="${attr(p.id)}"${p.id === view.projectId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
            </select>
          </label>
          <button type="button" class="btn" id="cs-reload">${esc(t('state.reloadCached'))}</button>
          <button type="button" class="btn primary" id="cs-rebuild"${rebuilding ? ' disabled' : ''}>${esc(rebuilding ? t('state.rebuilding') : t('state.rebuild'))}</button>
        </div>

        ${projects.status === 'error' ? `<div class="notice warn">${esc(t('state.projectsUnavailable', { message: projects.error?.message ?? '' }))}</div>` : ''}

        ${region(result, s => {
          const filled = SECTIONS.filter(([key]) => (s[key] ?? []).length);
          const totals = SECTIONS.reduce((n, [key]) => n + (s[key] ?? []).length, 0);
          return `
            <div class="notice">
              <b>${esc(scopeName())}</b> · ${esc(totals === 1 ? t('state.entryOne', { n: totals }) : t('state.entryMany', { n: totals }))} · ${esc(t('state.generated', { time: dateTime(s.generatedAt) }))}
              ${!view.projectId ? `<br><span class="dim">${esc(t('state.globalNote'))}</span>` : ''}
            </div>
            ${totals === 0
              ? `<div class="state-block empty"><p class="state-title">${esc(t('state.emptyTitle'))}</p><p class="state-hint">${esc(t('state.emptyHint'))}</p></div>`
              : `<div class="state-grid">${filled.map(([key, label]) => sectionCard(key, label, s[key])).join('')}</div>`}
          `;
        }, { loading: t('state.loading'), retry: 'reload-state', empty: t('state.none') })}`;
      wire();
    };

    const wire = () => {
      root.querySelector('#cs-project')?.addEventListener('change', e => { view.projectId = e.target.value; loadState(); });
      root.querySelector('#cs-reload')?.addEventListener('click', loadState);
      root.querySelector('#cs-rebuild')?.addEventListener('click', rebuild);
      root.querySelector('[data-action="reload-state"]')?.addEventListener('click', loadState);
    };

    paint();
    await Promise.all([loadProjects(), loadState()]);
  }
};
