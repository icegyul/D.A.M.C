import * as api from '../api.js';
import { state, idle, loading, ready, failed } from '../state.js';
import { esc, attr, badge, region, sectionTitle, dateTime, relative, truncate, pctText, kv, toast } from '../ui.js';
import { t } from '../i18n.js';

const STATUSES = ['candidate', 'confirmed', 'active', 'superseded', 'deprecated', 'archived'];
const IMPORTANCE_STEPS = [
  { value: '', label: () => t('memory.anyImportance') },
  { value: '0.9', label: () => t('memory.importanceAtLeast', { n: 90 }) },
  { value: '0.75', label: () => t('memory.importanceAtLeast', { n: 75 }) },
  { value: '0.5', label: () => t('memory.importanceAtLeast', { n: 50 }) }
];

export default {
  id: 'memory',

  async mount(root) {
    const view = state.memory;
    let list = idle();
    let detail = idle();
    let projects = idle();
    let providers = idle();
    let busyStatus = false;
    const listToken = { current: 0 };
    let searchTimer = null;

    const filters = () => ({
      q: view.q.trim() || undefined,
      projectId: view.projectId || undefined,
      status: view.status || undefined,
      provider: view.provider || undefined,
      minImportance: view.minImportance || undefined,
      sort: view.sort,
      limit: 100
    });

    async function loadList() {
      const token = (listToken.current += 1);
      list = loading(); paint();
      try {
        const rows = await api.getMemories(filters());
        if (token === listToken.current) list = ready(rows);
      } catch (e) {
        if (token === listToken.current) list = failed(e);
      }
      paint();
    }

    async function loadDetail(id) {
      view.selectedId = id;
      detail = loading(); paint();
      try { detail = ready(await api.getMemory(id)); } catch (e) { detail = failed(e); }
      paint();
    }

    async function loadFacets() {
      try { projects = ready(await api.getProjects()); } catch (e) { projects = failed(e); }
      try { providers = ready(await api.getMemoryProviders()); } catch (e) { providers = failed(e); }
      paint();
    }

    async function changeStatus(nextStatus) {
      const id = view.selectedId;
      if (!id) return;
      busyStatus = true; paint();
      try {
        await api.setMemoryStatus(id, nextStatus, t('memory.statusReason', { status: nextStatus }));
        toast(t('memory.statusSaved', { status: nextStatus }), 'good');
        busyStatus = false;
        await Promise.all([loadDetail(id), loadList()]);
      } catch (error) {
        busyStatus = false;
        toast(error.message, 'bad');
        paint();
      }
    }

    async function buildRelations() {
      const id = view.selectedId;
      if (!id) return;
      try {
        const result = await api.linkMemory(id, view.projectId || undefined);
        toast(t('memory.relationsDone', { n: result.created }), result.created ? 'good' : 'info');
        await loadDetail(id);
      } catch (error) {
        toast(error.message, 'bad');
      }
    }

    const filterBar = () => {
      const projectOptions = projects.status === 'ready' ? projects.data : [];
      const providerOptions = providers.status === 'ready' ? providers.data : [];
      return `<div class="toolbar" role="search">
        <label class="field grow">
          <span class="sr-only">${esc(t('memory.searchLabel'))}</span>
          <input type="search" id="mem-q" placeholder="${attr(t('memory.searchPlaceholder'))}" value="${attr(view.q)}" autocomplete="off">
        </label>
        <label class="field">
          <span class="sr-only">${esc(t('memory.project'))}</span>
          <select id="mem-project" aria-label="${attr(t('memory.filterProject'))}">
            <option value="">${esc(t('memory.allProjects'))}</option>
            ${projectOptions.map(p => `<option value="${attr(p.id)}"${p.id === view.projectId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select>
        </label>
        <label class="field">
          <span class="sr-only">${esc(t('memory.status'))}</span>
          <select id="mem-status" aria-label="${attr(t('memory.filterStatus'))}">
            <option value="">${esc(t('memory.allStatuses'))}</option>
            ${STATUSES.map(s => `<option value="${attr(s)}"${s === view.status ? ' selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
        </label>
        <label class="field">
          <span class="sr-only">${esc(t('memory.provider'))}</span>
          <select id="mem-provider" aria-label="${attr(t('memory.filterProvider'))}">
            <option value="">${esc(t('memory.allProviders'))}</option>
            ${providerOptions.map(p => `<option value="${attr(p.provider)}"${p.provider === view.provider ? ' selected' : ''}>${esc(p.provider)} (${p.total})</option>`).join('')}
          </select>
        </label>
        <label class="field">
          <span class="sr-only">${esc(t('memory.importance'))}</span>
          <select id="mem-importance" aria-label="${attr(t('memory.filterImportance'))}">
            ${IMPORTANCE_STEPS.map(s => `<option value="${attr(s.value)}"${s.value === view.minImportance ? ' selected' : ''}>${esc(s.label())}</option>`).join('')}
          </select>
        </label>
        <label class="field">
          <span class="sr-only">${esc(t('memory.sortLabel'))}</span>
          <select id="mem-sort" aria-label="${attr(t('memory.sortLabel'))}">
            <option value="newest"${view.sort === 'newest' ? ' selected' : ''}>${esc(t('memory.sortNewest'))}</option>
            <option value="relevance"${view.sort === 'relevance' ? ' selected' : ''}>${esc(view.q.trim() ? t('memory.sortRelevance') : t('memory.sortRelevanceHint'))}</option>
            <option value="importance"${view.sort === 'importance' ? ' selected' : ''}>${esc(t('memory.sortImportance'))}</option>
          </select>
        </label>
        <button type="button" class="btn" id="mem-reset">${esc(t('memory.reset'))}</button>
      </div>`;
    };

    const detailPanel = () => {
      if (!view.selectedId) {
        return `<div class="state-block empty"><p class="state-title">${esc(t('memory.noneSelected'))}</p><p class="state-hint">${esc(t('memory.noneSelectedHint'))}</p></div>`;
      }
      return region(detail, m => {
        const rel = m.relations ?? { outgoing: [], incoming: [] };
        // Every provider that ever stated this memory: its own source plus each
        // version's. More than one means the same fact arrived from more than
        // one AI and was merged rather than duplicated.
        const allProviders = [...new Set([m.provider, ...(m.versions ?? []).map(v => v.provider)].filter(Boolean))];
        const provenance = [
          [t('memory.project'), m.projectName ?? t('memory.notAssigned')],
          [t('memory.provider'), m.provider ?? t('memory.unknownProvider')],
          ...(allProviders.length > 1 ? [[t('memory.allProviders2'), allProviders.join(' + ')]] : []),
          [t('memory.source'), m.sourceTitle ?? m.sourceExternalId ?? t('memory.noSource')],
          [t('memory.conversation'), m.conversationTitle ?? m.conversationExternalId ?? '—'],
          [t('memory.sourceRef'), m.sourceExternalId ?? '—']
        ];
        return `
          <div class="detail-head">
            <div>${badge(m.type, 'muted')}${badge(m.status)}${m.version > 1 ? badge(`v${m.version}`, 'info') : ''}</div>
            <button type="button" class="icon-btn" id="mem-close" aria-label="${attr(t('memory.close'))}">✕</button>
          </div>
          <h3 class="detail-title">${esc(m.title)}</h3>
          <p class="detail-body">${esc(m.content)}</p>

          ${sectionTitle(t('memory.provenance'))}
          ${kv(provenance)}

          ${sectionTitle(t('memory.scores'))}
          ${kv([
            [t('memory.confidence'), pctText(m.confidence)],
            [t('memory.importance'), pctText(m.importance)],
            [t('memory.created'), dateTime(m.createdAt)],
            [t('memory.updated'), dateTime(m.updatedAt)]
          ])}

          ${sectionTitle(t('memory.status'))}
          <div class="btn-row" role="group" aria-label="${attr(t('memory.changeStatus'))}">
            ${STATUSES.map(s => `<button type="button" class="btn small${s === m.status ? ' active' : ''}" data-status="${attr(s)}"${busyStatus || s === m.status ? ' disabled' : ''}>${esc(s)}</button>`).join('')}
          </div>
          ${busyStatus ? `<p class="row-sub">${esc(t('memory.saving'))}</p>` : ''}
          ${api.isDemo() ? `<p class="row-sub warn-text">${esc(t('memory.demoStatus'))}</p>` : ''}

          ${sectionTitle(t('memory.versions', { n: (m.versions ?? []).length }))}
          ${(m.versions ?? []).length
            ? `<ul class="row-list compact">${m.versions.map(v => `<li class="row">
                <div class="row-main">
                  <p class="row-title">v${esc(v.versionNo)} · ${esc(v.status)}${v.provider ? ` · ${esc(v.provider)}` : ''}</p>
                  <p class="row-sub">${esc(v.changeReason ?? t('memory.noReason'))} · ${esc(dateTime(v.createdAt))}</p>
                </div></li>`).join('')}</ul>`
            : `<p class="state-hint">${esc(t('memory.noVersions'))}</p>`}

          ${sectionTitle(t('memory.relations', { n: rel.outgoing.length + rel.incoming.length }), `<button type="button" class="link-btn" id="mem-link">${esc(t('memory.buildRelations'))}</button>`)}
          ${(rel.outgoing.length + rel.incoming.length)
            ? `<ul class="row-list compact">${[
                ...rel.outgoing.map(r => ({ ...r, dir: '→' })),
                ...rel.incoming.map(r => ({ ...r, dir: '←' }))
              ].map(r => `<li class="row">
                <div class="row-main">
                  <p class="row-title">${esc(r.dir)} ${esc(r.relationType)}</p>
                  <p class="row-sub">${esc(truncate(r.title, 80))}</p>
                </div>
                <div class="row-side">${badge(pctText(r.confidence), 'muted')}</div>
              </li>`).join('')}</ul>`
            : `<p class="state-hint">${esc(t('memory.noRelations'))}</p>`}

          ${m.sourceMessage ? `${sectionTitle(t('memory.sourceMessage'))}
            <p class="row-sub">${esc(m.sourceMessage.role)} · #${esc(m.sourceMessage.sequenceNo)}</p>
            <pre class="raw">${esc(truncate(m.sourceMessage.content, 900))}</pre>` : ''}
        `;
      }, { loading: t('memory.loadingOne'), retry: 'reload-detail', empty: t('memory.notFound') });
    };

    const paint = () => {
      root.innerHTML = `
        ${filterBar()}
        <div class="memory-layout">
          <section class="card list-pane" aria-label="${attr(t('memory.listLabel'))}">
            ${region(list, rows => `
              <p class="list-count">${esc(rows.length === 1 ? t('memory.countOne', { n: rows.length }) : t('memory.countMany', { n: rows.length }))}${view.q.trim() ? esc(t('memory.matching', { q: view.q.trim() })) : ''}</p>
              <ul class="memory-items">${rows.map(m => `
                <li>
                  <button type="button" class="memory-item${m.id === view.selectedId ? ' selected' : ''}" data-id="${attr(m.id)}" aria-pressed="${m.id === view.selectedId}">
                    <span class="memory-item-head">
                      <span class="memory-item-project">${esc(m.projectName ?? t('memory.noProject'))}</span>
                      <span class="memory-item-badges">${badge(m.type, 'muted')}${badge(m.status)}</span>
                    </span>
                    <span class="memory-item-text">${esc(truncate(m.content ?? m.title, 200))}</span>
                    <span class="memory-item-meta">
                      <span>${esc(m.provider ?? t('memory.unknown'))}</span>
                      <span>${esc(t('memory.conf', { v: pctText(m.confidence) }))}</span>
                      <span>${esc(t('memory.imp', { v: pctText(m.importance) }))}</span>
                      <span>${esc(relative(m.updatedAt))}</span>
                    </span>
                  </button>
                </li>`).join('')}</ul>`, {
                loading: t('memory.loading'), retry: 'reload-list',
                empty: view.q.trim() || view.projectId || view.status || view.provider || view.minImportance
                  ? t('memory.noMatch')
                  : t('memory.none'),
                emptyHint: t('memory.noneHint')
              })}
          </section>
          <aside class="card detail-pane" aria-label="${attr(t('memory.detailLabel'))}" aria-live="polite">${detailPanel()}</aside>
        </div>`;
      wire();
    };

    const wire = () => {
      const q = root.querySelector('#mem-q');
      if (q) {
        q.addEventListener('input', event => {
          view.q = event.target.value;
          clearTimeout(searchTimer);
          searchTimer = setTimeout(loadList, 280);
        });
      }
      const bind = (sel, key) => root.querySelector(sel)?.addEventListener('change', e => { view[key] = e.target.value; loadList(); });
      bind('#mem-project', 'projectId');
      bind('#mem-status', 'status');
      bind('#mem-provider', 'provider');
      bind('#mem-importance', 'minImportance');
      bind('#mem-sort', 'sort');
      root.querySelector('#mem-reset')?.addEventListener('click', () => {
        Object.assign(view, { q: '', projectId: '', status: '', provider: '', minImportance: '', sort: 'newest' });
        loadList();
      });
      root.querySelectorAll('.memory-item').forEach(btn => btn.addEventListener('click', () => loadDetail(btn.dataset.id)));
      root.querySelectorAll('[data-status]').forEach(btn => btn.addEventListener('click', () => changeStatus(btn.dataset.status)));
      root.querySelector('#mem-link')?.addEventListener('click', buildRelations);
      root.querySelector('#mem-close')?.addEventListener('click', () => { view.selectedId = null; detail = idle(); paint(); });
      root.querySelector('[data-action="reload-list"]')?.addEventListener('click', loadList);
      root.querySelector('[data-action="reload-detail"]')?.addEventListener('click', () => loadDetail(view.selectedId));
    };

    paint();
    await Promise.all([loadFacets(), loadList()]);
    if (view.selectedId) await loadDetail(view.selectedId);
  }
};
