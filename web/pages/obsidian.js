import * as api from '../api.js';
import { idle, loading, ready, failed } from '../state.js';
import { esc, sectionTitle, region, relative, dateTime, num, toast, kv } from '../ui.js';
import { t } from '../i18n.js';

/**
 * Obsidian — the human view of DAMC's memory.
 *
 * This page replaced the in-app graph. DAMC does not draw the knowledge graph
 * itself; it writes one Markdown note per memory, with relations as wikilinks,
 * into a folder the user opens in Obsidian, and Obsidian's Graph View draws it.
 * Roles are deliberately fixed: DAMC is the source of truth, Obsidian is a view.
 * Sync overwrites the notes it wrote; nothing flows back.
 *
 * Everything shown here is read from the vault folder and the database — whether
 * the folder exists, when the index note was last written, how many notes are in
 * it, and what the next sync would write. No state flag can drift from reality.
 */

const STATUS = {
  synced:   ['obsidian.statusSynced',   'chip-available'],
  never:    ['obsidian.statusNever',    'chip-needs_configuration'],
  noFolder: ['obsidian.statusNoFolder', 'chip-not_available']
};

function statusOf(s) {
  if (!s) return 'noFolder';
  if (s.synced) return 'synced';
  return s.folderExists ? 'never' : 'noFolder';
}

export default {
  id: 'obsidian',

  async mount(root) {
    let status = idle();
    let syncing = false;

    async function load() {
      status = loading(); paint();
      try { status = ready(await api.getObsidianStatus()); } catch (e) { status = failed(e); }
      paint();
    }

    async function sync() {
      syncing = true; paint();
      try {
        const r = await api.exportObsidian();
        const pathShown = status.data?.hostPath ?? r?.root ?? '';
        if (r?.failed) toast(t('obsidian.syncedPartial', { notes: num(r.memories ?? 0), failed: num(r.failed), path: pathShown }), 'info');
        else toast(t('obsidian.synced', { notes: num(r?.memories ?? 0), path: pathShown }), 'good');
      } catch (e) {
        toast(e.message, 'bad');
      }
      syncing = false;
      await load();
    }

    const chip = s => {
      const [key, cls] = STATUS[statusOf(s)];
      return `<span class="chip ${cls}">${esc(t(key))}</span>`;
    };

    function paint() {
      root.innerHTML = `
        <section class="card">
          ${sectionTitle(t('obsidian.title'), region(status, chip, { loading: '', empty: '' }))}
          <p class="row-sub">${esc(t('obsidian.intro'))}</p>
          <p class="row-sub dim">${esc(t('obsidian.roles'))}</p>
        </section>

        <div class="grid-2col">
          <section class="card" aria-label="${esc(t('obsidian.vaultLabel'))}">
            ${sectionTitle(t('obsidian.vaultLabel'))}
            ${region(status, s => `
              ${kv([
                [t('obsidian.pathLabel'), s.hostPath || s.vaultPath || '—'],
                [t('obsidian.lastSync'), s.lastSyncAt ? `${esc(relative(s.lastSyncAt))} · ${esc(dateTime(s.lastSyncAt))}` : '—'],
                [t('obsidian.notes'), s.folderExists ? num(s.noteCount) : '—']
              ])}
              <p class="row-sub dim mt">${esc(t('obsidian.pathHint'))}</p>
              <div class="btn-row mt">
                <button type="button" class="btn small primary" id="obsidian-sync"${syncing || api.isDemo() ? ' disabled' : ''}>${esc(syncing ? t('obsidian.syncing') : t('obsidian.sync'))}</button>
                <button type="button" class="btn small" id="obsidian-copy"${s.hostPath || s.vaultPath ? '' : ' disabled'}>${esc(t('obsidian.copyPath'))}</button>
              </div>`, { loading: t('connections.loading'), retry: 'reload-obsidian', empty: t('obsidian.statusNoFolder') })}
          </section>

          <section class="card" aria-label="${esc(t('obsidian.targets'))}">
            ${sectionTitle(t('obsidian.targets'))}
            ${region(status, s => `
              <ul class="row-list">
                <li class="row"><div class="row-main"><p class="row-title">${esc(t('obsidian.tMemories'))}</p></div><div class="row-side"><span class="count">${num(s.targets?.memories)}</span></div></li>
                <li class="row"><div class="row-main"><p class="row-title">${esc(t('obsidian.tDecisions'))}</p></div><div class="row-side"><span class="count">${num(s.targets?.decisions)}</span></div></li>
                <li class="row"><div class="row-main"><p class="row-title">${esc(t('obsidian.tTasks'))}</p></div><div class="row-side"><span class="count">${num(s.targets?.tasks)}</span></div></li>
                <li class="row"><div class="row-main"><p class="row-title">${esc(t('obsidian.tRelations'))}</p></div><div class="row-side"><span class="count">${num(s.targets?.relations)}</span></div></li>
              </ul>
              <p class="row-sub dim mt">${esc(t('obsidian.tConversations'))}</p>`, { loading: t('connections.loading'), retry: 'reload-obsidian', empty: t('obsidian.statusNoFolder') })}
          </section>
        </div>

        <section class="card">
          ${sectionTitle(t('obsidian.howTo'))}
          <ol class="pipeline">
            <li><span>${esc(t('obsidian.how1'))}</span></li>
            <li><span>${esc(t('obsidian.how2'))}</span></li>
            <li><span>${esc(t('obsidian.how3'))}</span></li>
            <li><span>${esc(t('obsidian.how4'))}</span></li>
          </ol>
          <p class="row-sub dim mt">${esc(t('obsidian.legacyNote'))}</p>
        </section>`;

      root.querySelector('#obsidian-sync')?.addEventListener('click', sync);
      root.querySelector('#obsidian-copy')?.addEventListener('click', async () => {
        const p = status.data?.hostPath || status.data?.vaultPath || '';
        try { await navigator.clipboard.writeText(p); toast(t('connections.copied'), 'good'); }
        catch { toast(p, 'info'); }
      });
      root.querySelector('[data-action="reload-obsidian"]')?.addEventListener('click', load);
    }

    await load();
    return () => { /* nothing to tear down */ };
  }
};
