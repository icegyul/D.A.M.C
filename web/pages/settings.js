import * as api from '../api.js';
import { state, setTheme, setLanguage, notify } from '../state.js';
import { esc, attr, sectionTitle, dateTime, toast } from '../ui.js';
import { t, LANGUAGES } from '../i18n.js';

export default {
  id: 'settings',

  async mount(root, ctx) {
    let testResult = null;   // { ok, message }
    let testing = false;
    let running = null;      // name of the running data operation
    let lastOperation = null;

    async function testConnection() {
      testing = true; testResult = null; paint();
      try {
        const health = await api.testConnection();
        testResult = { ok: true, message: t('settings.connected', { service: health.service ?? 'damc', version: health.version ?? '?' }) + (health.devMode ? t('settings.devModeSuffix') : '') };
      } catch (error) {
        testResult = { ok: false, message: error.message };
      }
      testing = false;
      if (!await ctx.probeConnection()) paint();
    }

    async function runOperation(name, fn, describe) {
      running = name; lastOperation = null; paint();
      try {
        const result = await fn();
        lastOperation = { ok: true, name, text: describe(result) };
        toast(lastOperation.text, 'good');
      } catch (error) {
        lastOperation = { ok: false, name, text: error.message };
        toast(error.message, 'bad');
      }
      running = null;
      paint();
    }

    const paint = () => {
      const s = api.loadSettings();
      const conn = api.connection;
      root.innerHTML = `
        <div class="grid-2col">
          <section class="card" aria-label="${attr(t('settings.backendLabel'))}">
            ${sectionTitle(t('settings.backend'))}
            <div class="form-grid">
              <label class="field block">
                <span class="field-label">${esc(t('settings.endpoint'))}</span>
                <input id="set-base" type="url" value="${attr(s.baseUrl)}" placeholder="${attr(t('settings.endpointPlaceholder', { origin: location.origin }))}" autocomplete="off">
              </label>
              <label class="field block">
                <span class="field-label">${esc(t('settings.apiKey'))}</span>
                <input id="set-key" type="password" value="${attr(s.apiKey)}" placeholder="${attr(t('settings.apiKeyPlaceholder'))}" autocomplete="off">
              </label>
              <label class="field block">
                <span class="field-label">${esc(t('settings.devUser'))} <span class="dim">${esc(t('settings.devUserHint'))}</span></span>
                <input id="set-user" type="text" value="${attr(s.userId)}" placeholder="00000000-0000-0000-0000-000000000001" autocomplete="off">
              </label>
            </div>
            <div class="btn-row">
              <button type="button" class="btn primary" id="set-save">${esc(t('settings.save'))}</button>
              <button type="button" class="btn" id="set-test"${testing ? ' disabled' : ''}>${esc(testing ? t('settings.testing') : t('settings.test'))}</button>
              <button type="button" class="btn" id="set-clear">${esc(t('settings.clear'))}</button>
            </div>
            <p class="row-sub dim mt">${esc(t('settings.storageNote'))}</p>
            ${testResult ? `<div class="notice ${testResult.ok ? 'good' : 'bad'}" role="status">${esc(testResult.message)}</div>` : ''}
          </section>

          <section class="card" aria-label="${attr(t('settings.statusLabel'))}">
            ${sectionTitle(t('settings.status'))}
            <dl class="kv">
              <dt>${esc(t('settings.mode'))}</dt><dd><span class="chip chip-${conn.mode === 'live' ? 'available' : 'not_available'}">${esc(conn.mode === 'live' ? t('conn.live') : t('conn.demo'))}</span></dd>
              <dt>${esc(t('settings.endpointRow'))}</dt><dd>${esc(s.baseUrl || location.origin)}</dd>
              <dt>${esc(t('settings.auth'))}</dt><dd>${esc(s.apiKey ? t('settings.authBearer') : s.userId ? t('settings.authDevUser') : t('settings.authNone'))}</dd>
              <dt>${esc(t('settings.service'))}</dt><dd>${esc(conn.health ? `${conn.health.service} v${conn.health.version}` : '—')}</dd>
              <dt>${esc(t('settings.backendDevMode'))}</dt><dd>${conn.health ? esc(String(conn.health.devMode)) : '—'}</dd>
              <dt>${esc(t('settings.lastChecked'))}</dt><dd>${esc(dateTime(conn.checkedAt))}</dd>
              ${conn.mode !== 'live' ? `<dt>${esc(t('settings.reason'))}</dt><dd>${esc(conn.reason ?? t('conn.unreachable'))}</dd>` : ''}
            </dl>
            ${conn.mode !== 'live'
              ? `<p class="row-sub warn-text">${esc(t('settings.demoNote'))}</p>`
              : `<p class="row-sub">${esc(t('settings.liveNote'))}</p>`}
          </section>

          <section class="card" aria-label="${attr(t('settings.appearanceLabel'))}">
            ${sectionTitle(t('settings.appearance'))}
            <div class="btn-row" role="group" aria-label="${attr(t('settings.theme'))}">
              <button type="button" class="btn${state.theme === 'light' ? ' primary' : ''}" data-theme="light" aria-pressed="${state.theme === 'light'}">${esc(t('settings.light'))}</button>
              <button type="button" class="btn${state.theme === 'dark' ? ' primary' : ''}" data-theme="dark" aria-pressed="${state.theme === 'dark'}">${esc(t('settings.dark'))}</button>
            </div>

            ${sectionTitle(t('settings.language'))}
            <div class="btn-row" role="group" aria-label="${attr(t('settings.languageGroup'))}">
              ${LANGUAGES.map(l => `<button type="button" class="btn${state.language === l.id ? ' primary' : ''}" data-language="${attr(l.id)}" lang="${attr(l.id)}" aria-pressed="${state.language === l.id}">${esc(l.label)}</button>`).join('')}
            </div>
            <p class="row-sub dim mt">${esc(t('settings.languageNote'))}</p>
          </section>

          <section class="card" aria-label="${attr(t('settings.dataLabel'))}">
            ${sectionTitle(t('settings.data'))}
            <ul class="row-list">
              <li class="row">
                <div class="row-main">
                  <p class="row-title">${esc(t('settings.jsonExport'))}</p>
                  <p class="row-sub">${esc(t('settings.jsonExportBody'))}</p>
                </div>
                <button type="button" class="btn small" data-op="json"${running ? ' disabled' : ''}>${esc(running === 'json' ? t('settings.runningOp') : t('settings.run'))}</button>
              </li>
              <li class="row">
                <div class="row-main">
                  <p class="row-title">${esc(t('settings.obsidianExport'))}</p>
                  <p class="row-sub">${esc(t('settings.obsidianExportBody'))}</p>
                </div>
                <button type="button" class="btn small" data-op="obsidian"${running ? ' disabled' : ''}>${esc(running === 'obsidian' ? t('settings.runningOp') : t('settings.run'))}</button>
              </li>
              <li class="row">
                <div class="row-main">
                  <p class="row-title">${esc(t('settings.githubBackup'))}</p>
                  <p class="row-sub">${esc(t('settings.githubBackupBody'))}</p>
                </div>
                <button type="button" class="btn small" data-op="github"${running ? ' disabled' : ''}>${esc(running === 'github' ? t('settings.runningOp') : t('settings.run'))}</button>
              </li>
            </ul>
            ${lastOperation ? `<div class="notice ${lastOperation.ok ? 'good' : 'bad'}" role="status">${esc(lastOperation.text)}</div>` : ''}
            ${api.isDemo() ? `<p class="row-sub warn-text mt">${esc(t('settings.demoOps'))}</p>` : ''}
          </section>
        </div>`;
      wire();
    };

    const wire = () => {
      root.querySelector('#set-save')?.addEventListener('click', async () => {
        api.saveSettings({
          baseUrl: root.querySelector('#set-base').value.trim(),
          apiKey: root.querySelector('#set-key').value.trim(),
          userId: root.querySelector('#set-user').value.trim()
        });
        toast(t('settings.saved'), 'info');
        if (!await ctx.probeConnection()) paint();
      });
      root.querySelector('#set-test')?.addEventListener('click', testConnection);
      root.querySelector('#set-clear')?.addEventListener('click', async () => {
        api.saveSettings({ apiKey: '', userId: '' });
        toast(t('settings.cleared'), 'info');
        if (!await ctx.probeConnection()) paint();
      });
      root.querySelectorAll('[data-theme]').forEach(btn => btn.addEventListener('click', () => { setTheme(btn.dataset.theme); paint(); }));
      // Language changes every label on screen, so the whole shell is repainted.
      root.querySelectorAll('[data-language]').forEach(btn => btn.addEventListener('click', () => {
        setLanguage(btn.dataset.language);
        ctx.rerenderShell?.();
      }));
      root.querySelectorAll('[data-op]').forEach(btn => btn.addEventListener('click', () => {
        const op = btn.dataset.op;
        if (op === 'json') runOperation('json', api.exportJson, r => t('settings.jsonDone', { memories: r?.memories?.length ?? 0, relations: r?.relations?.length ?? 0 }));
        if (op === 'obsidian') runOperation('obsidian', api.exportObsidian, r => t('settings.obsidianDone', { root: r?.root ?? 'vault', memories: r?.memories ?? 0 }));
        if (op === 'github') runOperation('github', api.backupGithub, r => (r?.enabled === false ? r.message : r?.pushed ? t('settings.githubPushed', { repo: r.repo, branch: r.branch }) : r?.message ?? t('settings.githubDone')));
      }));
      notify();
    };

    paint();
  }
};
