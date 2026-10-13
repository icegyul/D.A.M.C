import * as api from '../api.js';
import { state, idle, loading, ready, failed } from '../state.js';
import { esc, attr, badge, region, sectionTitle, relative, dateTime, num, toast } from '../ui.js';
import { t } from '../i18n.js';
import { state as appState } from '../state.js';

/**
 * Sync Center — the one screen that answers, in this order (§21 of the spec):
 *   is it connected? · is auto-import on? · when did it last import? · how much is remembered?
 *
 * Every number here is live backend data. There is deliberately no demo
 * fallback on this page: fabricated counts would be indistinguishable from
 * real ones, so without a backend the page says so instead of filling in.
 */

function channelLabel(channel) {
  const key = `channel.${channel.id}`;
  const translated = t(key);
  return translated === key ? channel.label : translated;
}

const STATE_LABEL = {
  available: 'connections.available',
  needs_configuration: 'connections.needsConfig',
  not_available: 'connections.notAvailable'
};

/** The claims a user actually acts on, in the order the spec lists them: what works, then what does not. */
const CAPABILITY_ROWS = [
  ['import', 'connections.capImport'],
  ['manualSync', 'connections.capManualSync'],
  ['contextExport', 'connections.capContextExport'],
  ['autoSync', 'connections.capAutoSync'],
  ['contextPush', 'connections.capContextPush']
];

export default {
  id: 'connections',

  async mount(root) {
    let status = idle();     // connector capabilities + watch folder + AI hub
    let jobs = idle();       // recent sync jobs
    let stats = idle();      // common memory counts
    let keys = idle();       // API keys for the remote gateway
    let busyProvider = null;
    // The raw key exists only in this tab's memory between creation and
    // dismissal — the backend stores a hash and the list endpoint never
    // returns secrets, so configs can only carry a key the user just created.
    let freshKey = null;
    let freshKeyLabel = null;
    let newKeyLabel = '';
    let remote = idle();       // Remote Access state (tunnel / own endpoint)
    let busyRemote = false;
    let verifyResult = null;
    let activity = idle();     // recent MCP tool calls (real audit feed)
    let busyTest = null;       // provider id whose Test Memory is running
    let setupModalFor = null;  // provider id whose setup dialog is open
    let skillText = null;      // shared DAMC skill, fetched when a setup dialog opens
    let busyKey = null;
    let lastTest = {};        // provider -> { ok, message, at } from the last connection test

    async function load() {
      if (api.isDemo()) {
        // Demo keeps the AI hub visible: provider capability truth is policy,
        // not user data. Only per-user state (activity, keys) is empty here.
        status = ready(await api.getConnectorStatus());
        jobs = idle(); stats = idle(); keys = idle(); remote = idle(); activity = idle();
        paint(); return;
      }
      status = loading(); jobs = loading(); stats = loading(); keys = loading(); remote = loading(); activity = loading(); paint();
      const [s, j, d, k, r, a] = await Promise.allSettled([api.getConnectorStatus(), api.getSyncJobs(6), api.getDashboard(), api.listApiKeys(), api.getRemoteAccess(), api.getMcpActivity(20)]);
      status = s.status === 'fulfilled' ? ready(s.value) : failed(s.reason);
      jobs = j.status === 'fulfilled' ? ready(j.value) : failed(j.reason);
      stats = d.status === 'fulfilled' ? ready(d.value) : failed(d.reason);
      keys = k.status === 'fulfilled' ? ready(k.value) : failed(k.reason);
      remote = r.status === 'fulfilled' ? ready(r.value) : failed(r.reason);
      activity = a.status === 'fulfilled' ? ready(a.value) : failed(a.reason);
      paint();
    }

    async function toggleConnection(provider, connected) {
      busyProvider = provider; paint();
      try {
        if (connected) await api.disconnectProvider(provider);
        else await api.connectProvider(provider);
        toast(connected ? t('connections.disconnected', { provider }) : t('connections.connected', { provider }), 'good');
        busyProvider = null;
        await load();
        return;
      } catch (error) {
        toast(error.message, 'bad');
      }
      busyProvider = null;
      paint();
    }

    // ------------------------------------------------------------- AI hub

    /** Substitute a just-created key into a generated config; without one, the placeholder stays visible. */
    function renderConfig(config) {
      const text = typeof config === 'string' ? config : JSON.stringify(config, null, 2);
      return freshKey ? text.replaceAll('<YOUR_DAMC_API_KEY>', freshKey) : text;
    }

    /** One command the user runs on their own machine. The key is embedded only
     * when it was just created in this tab — otherwise the placeholder stays and
     * the hint below says to replace it. */
    function cliCommand(c, gatewayUrl) {
      const key = freshKey ?? '<YOUR_DAMC_API_KEY>';
      const base = `damc ai setup ${c.provider} --url ${gatewayUrl || '<damc-url>'}`;
      const setup = (c.provider === 'claude' || c.provider === 'cursor') ? `${base} --key ${key} --apply` : `${base} --apply`;
      const skill = (c.provider === 'claude' || c.provider === 'cursor') ? `\ndamc ai skill ${c.provider} --apply` : '';
      return `${setup}${skill}`;
    }

    function capabilityChip(labelKey, on) {
      return `<span class="chip ${on ? 'chip-available' : 'chip-not_available'}">${esc(t(labelKey))}${on ? ' ✓' : ' ✕'}</span>`;
    }

    /** Platform reachability — what the provider's host allows at all. */
    const platformChip = s => {
      const cls = s === 'available' ? 'chip-available' : s === 'limited' ? 'chip-needs_configuration' : 'chip-not_available';
      const label = s === 'available' ? t('connections.statusAvailable') : s === 'limited' ? t('connections.statusLimited') : t('connections.statusUnsupported');
      return `<span class="chip ${cls}">${esc(label)}</span>`;
    };

    /** THIS user's real state, from API keys + MCP audit activity (never a bare flag). */
    // What the chip means, in one sentence. Only ACTIVE says "connected".
    const statusHint = cs => t({
      ACTIVE: 'connections.hintActive',
      WRITE_READY: 'connections.hintReady',
      READ_READY: 'connections.hintReady',
      AUTHENTICATED: 'connections.hintAuthenticated',
      CONFIGURED: 'connections.hintConfigured',
      NOT_CONFIGURED: 'connections.hintNotConfigured'
    }[cs] ?? 'connections.noActivity');

    const connectionChip = cs => {
      const map = {
        ACTIVE: ['connections.connActive', 'chip-available'],
        WRITE_READY: ['connections.connWriteReady', 'chip-available'],
        READ_READY: ['connections.connReadReady', 'chip-needs_configuration'],
        AUTHENTICATED: ['connections.connAuthenticated', 'chip-needs_configuration'],
        CONFIGURED: ['connections.connConfigured', 'chip-needs_configuration'],
        NOT_CONFIGURED: ['connections.connNotConfigured', 'chip-not_available'],
        NOT_SUPPORTED: ['connections.connNotSupported', 'chip-not_available'],
        ERROR: ['connections.connError', 'chip-not_available']
      };
      const [labelKey, cls] = map[cs] ?? map.NOT_CONFIGURED;
      return `<span class="chip ${cls}">${esc(t(labelKey))}</span>`;
    };

    const CAPABILITY_ROWS_AI = [
      ['read', 'connections.capRead'], ['write', 'connections.capWrite'], ['update', 'connections.capUpdate'],
      ['context', 'connections.capContext'], ['session', 'connections.capSession'],
      ['liveSync', 'connections.capLiveSync'], ['push', 'connections.capPush']
    ];

    const usageRow = (label, at) => `<li><span>${esc(label)}</span><span>${esc(at ? relative(at) : '—')}</span></li>`;

    // The catalog is authored in English; where it carries a Korean variant,
    // a Korean UI shows that instead. English remains the fallback.
    const ko = () => appState.language === 'ko';
    const noteOf = c => (ko() && c.noteKo) ? c.noteKo : c.note;
    const stepsOf = c => (ko() && c.setup?.stepsKo) ? c.setup.stepsKo : (c.setup?.steps ?? []);
    const summaryOf = c => (ko() && c.setup?.summaryKo) ? c.setup.summaryKo : (c.setup?.summary ?? '');

    const aiClientCard = c => {
      const usage = c.usage;
      const active = c.connectionStatus === 'ACTIVE';
      const lt = lastTest[c.provider];
      const testing = busyTest === c.provider;
      return `
        <article class="sync-provider" aria-label="${attr(c.label)}">
          <div class="sync-provider-head">
            <h4 class="connector-name">${esc(c.label)}</h4>
            ${connectionChip(c.connectionStatus)}
          </div>
          <p class="row-sub">${esc(noteOf(c))}</p>
          <div class="cap-grid mt">
            ${CAPABILITY_ROWS_AI.map(([key, labelKey]) => capabilityChip(labelKey, c.capabilities[key])).join('')}
          </div>
          ${usage ? `<ul class="usage-list">
            ${usageRow(t('connections.lastRead'), usage.lastReadAt)}
            ${usageRow(t('connections.lastWrite'), usage.lastWriteAt)}
            ${usageRow(t('connections.lastContext'), usage.lastContextAt)}
            ${usageRow(t('connections.lastSession'), usage.lastSessionAt)}
            <li><span>${esc(t('connections.totalCalls'))}</span><span>${num(usage.totalCalls)}</span></li>
          </ul>` : ''}
          <p class="row-sub dim mt">${esc(statusHint(c.connectionStatus))}</p>
          ${lt ? `<p class="row-sub ${lt.ok ? 'good-text' : 'warn-text'}">${esc(lt.message)}${lt.ok ? '' : ' ' + esc(t('connections.testNext'))}</p>` : ''}
          <div class="btn-row">
            <button type="button" class="btn small${active ? '' : ' primary'}" data-toggle-modal="${attr(c.provider)}">${esc(t('connections.openSetup'))}</button>
            <button type="button" class="btn small" data-test-memory="${attr(c.provider)}"${testing || api.isDemo() ? ' disabled' : ''}>${esc(testing ? t('connections.testing') : t('connections.testConnection'))}</button>
            <button type="button" class="btn small" data-goto="memory">${esc(t('connections.viewMemories'))}</button>
          </div>
        </article>`;
    };

    /** Real MCP tool calls, newest first — rows come from the audit trail, never fabricated. */
    const activityCard = () => `
      <section class="card" aria-label="${attr(t('connections.activityTitle'))}">
        ${sectionTitle(t('connections.activityTitle'))}
        <p class="row-sub">${esc(t('connections.activityIntro'))}</p>
        ${region(activity, data => (data.activity ?? []).length ? `
          <div class="table-scroll mt">
            <table class="table">
              <thead><tr>
                <th scope="col">${esc(t('connections.activityWhen'))}</th>
                <th scope="col">${esc(t('connections.activityClient'))}</th>
                <th scope="col">${esc(t('connections.activityTool'))}</th>
                <th scope="col">${esc(t('connections.activityProject'))}</th>
                <th scope="col">${esc(t('connections.activityKind'))}</th>
                <th scope="col">${esc(t('connections.keyStatus'))}</th>
              </tr></thead>
              <tbody>${(data.activity ?? []).map(a => `
                <tr class="${a.ok ? '' : 'row-bad'}">
                  <td title="${esc(dateTime(a.at))}">${esc(relative(a.at))}</td>
                  <td>${esc(a.client)}</td>
                  <td><code>${esc(a.tool)}</code></td>
                  <td>${esc(a.projectName ?? '—')}</td>
                  <td>${esc(a.kind)}</td>
                  <td>${a.ok ? esc(t('connections.activityOk')) : esc(t('connections.activityFailed'))}</td>
                </tr>`).join('')}</tbody>
            </table>
          </div>` : `<p class="row-sub dim mt">${esc(t('connections.activityEmpty'))}</p>`,
        { loading: t('connections.loading'), retry: 'reload-sync-center', empty: t('connections.activityEmpty') })}
      </section>`;

    const onboardingCard = () => {
      const k = keys;
      const noKeys = k.status === 'ready' && (k.data?.keys?.length ?? 0) === 0;
      if (k.status !== 'ready' || !noKeys) return '';
      return `
        <section class="card" aria-label="${attr(t('connections.onboardingTitle'))}">
          ${sectionTitle(t('connections.onboardingTitle'))}
          <ol class="onboarding-steps">
            <li><span class="onboarding-num">1</span><span>${esc(t('connections.onbStep1'))}</span>
              <form id="onboard-project-form" class="btn-row" style="margin-left:auto">
                <input id="onboard-project" type="text" class="field" style="max-width:180px" placeholder="${attr(t('connections.onbProjectPlaceholder'))}" aria-label="${attr(t('connections.onbStep1'))}" required>
                <button type="submit" class="btn small" id="btn-onboard-project">${esc(t('connections.onbCreate'))}</button>
              </form>
            </li>
            <li><span class="onboarding-num">2</span><span>${esc(t('connections.onbStep2'))}</span></li>
            <li><span class="onboarding-num">3</span><span>${esc(t('connections.onbStep3'))}</span></li>
            <li><span class="onboarding-num">4</span><span>${esc(t('connections.onbStep4'))}</span></li>
            <li><span class="onboarding-num">5</span><span>${esc(t('connections.onbStep5'))}</span></li>
            <li><span class="onboarding-num">6</span><span>${esc(t('connections.onbStep6'))}</span></li>
          </ol>
        </section>`;
    };

    const remoteAccessCard = () => `
      <section class="card" aria-label="${attr(t('connections.remoteTitle'))}">
        ${sectionTitle(t('connections.remoteTitle'), `<span class="chip ${remote.data?.enabled ? 'chip-available' : 'chip-not_available'}">${esc(remote.data?.enabled ? t('connections.remoteOn') : t('connections.remoteOff'))}</span>`)}
        <p class="row-sub">${esc(t('connections.remoteIntro'))}</p>
        ${remote.data?.endpoint ? `<p class="row-sub mt">${esc(t('connections.remoteEndpoint'))}: <code>${esc(remote.data.endpoint)}</code>
          <button type="button" class="btn small" data-copy-endpoint>${esc(t('connections.copy'))}</button>
          (${esc(remote.data.source === 'own_endpoint' ? t('connections.remoteSourceOwn') : remote.data.source === 'named_tunnel' ? t('connections.remoteSourceNamed') : t('connections.remoteSourceTunnel'))})</p>` : ''}
        ${remote.data?.lastVerifiedAt ? `<p class="row-sub">${esc(t('connections.remoteLastReachable'))}: ${esc(relative(remote.data.lastVerifiedAt))} · ${esc(remote.data.lastVerifyOk ? t('connections.activityOk') : t('connections.activityFailed'))}</p>` : ''}
        ${remote.data?.source === 'quick_tunnel' ? `<p class="row-sub dim">${esc(t('connections.repointHint'))}</p>` : ''}
        <div class="remote-actions">
          <button type="button" class="btn small ${remote.data?.enabled ? '' : 'primary'}" id="btn-remote-toggle"${busyRemote || api.isDemo() ? ' disabled' : ''}>
            ${esc(busyRemote ? t('connections.remoteWorking') : remote.data?.enabled ? t('connections.remoteDisable') : t('connections.remoteEnable'))}
          </button>
          ${remote.data?.endpoint ? `<button type="button" class="btn small" id="btn-remote-verify"${busyRemote || api.isDemo() ? ' disabled' : ''}>${esc(t('connections.remoteVerify'))}</button>` : ''}
        </div>
        ${remote.data && !remote.data.enabled && !remote.data.tunnelAvailable ? `<p class="row-sub dim mt">${esc(t('connections.remoteNoCloudflared'))}</p>` : ''}
        ${remote.data?.tunnelError ? `<div class="notice bad mt" role="alert">${esc(remote.data.tunnelError)}</div>` : ''}
        ${verifyResult ? `<div class="notice ${verifyResult.ok ? 'good' : 'bad'} mt" role="status">${esc(verifyResult.message)}</div>` : ''}
        <p class="row-sub dim mt">${esc(t('connections.remoteSecurityNote'))}</p>
      </section>`;

    const aiHubCard = () => `
      <section class="card" aria-label="${attr(t('connections.hubTitle'))}">
        ${sectionTitle(t('connections.hubTitle'))}
        <p class="row-sub">${esc(t('connections.hubIntro'))}</p>
        <p class="row-sub dim">${esc(t('connections.mcpPlain'))}</p>
        ${region(status, data => `
          ${data.gateway ? `<p class="row-sub mt">${esc(t('connections.gatewayLabel'))}: <code>${esc(data.gateway.url)}</code> · ${esc(data.gateway.transport)} · ${esc(t('connections.gatewayAuth'))}</p>` : ''}
          ${[['agent', 'connections.groupAgents'], ['service', 'connections.groupServices']].map(([kind, titleKey]) => {
            const cards = (data.aiClients ?? []).filter(c => (c.kind ?? 'service') === kind);
            return cards.length ? `<div class="client-group mt"><h4>${esc(t(titleKey))}</h4><div class="provider-grid">${cards.map(aiClientCard).join('')}</div></div>` : '';
          }).join('')}`, { loading: t('connections.loading'), retry: 'reload-sync-center', empty: t('connections.none') })}
      </section>`;

    /** §22 — the per-provider setup dialog. */
    const setupModal = () => {
      if (!setupModalFor) return '';
      const data = status.status === 'ready' ? status.data : null;
      const c = (data?.aiClients ?? []).find(x => x.provider === setupModalFor);
      if (!c) return '';
      const configText = renderConfig(c.config);
      return `
        <div class="modal-scrim" id="modal-scrim" role="presentation">
          <div class="modal" role="dialog" aria-modal="true" aria-label="${attr(c.label)}">
            <div class="modal-head">
              <h3>${esc(c.label)} · ${esc(t('connections.setup'))}</h3>
              <button type="button" class="modal-close" id="modal-close" aria-label="${attr(t('connections.modalClose'))}">✕</button>
            </div>
            <dl class="kv">
              <dt>${esc(t('connections.modalEndpoint'))}</dt><dd><code>${esc(data?.gateway?.url ?? '')}</code></dd>
              <dt>${esc(t('connections.modalAuth'))}</dt><dd>${esc(t('connections.modalAuthValue'))}</dd>
              <dt>${esc(t('connections.modalStatus'))}</dt><dd>${connectionChip(c.connectionStatus)}</dd>
            </dl>
            <p class="row-sub mt">${esc(t('connections.modalExplanation'))}</p>
            ${c.capabilities.write ? '' : `<p class="row-sub warn-text">${esc(t('connections.modalWriteLimited'))}</p>`}
            <div class="setup-step">
              <h4>${esc(t('connections.step1'))}</h4>
              ${freshKey
                ? `<p class="row-sub good-text">${esc(t('connections.step1Done'))}</p>`
                : `<p class="row-sub">${esc(t('connections.step1Body'))}</p>
                   <div class="btn-row"><button type="button" class="btn small primary" id="modal-create-key"${busyKey === 'create' ? ' disabled' : ''}>${esc(busyKey === 'create' ? t('connections.working') : t('connections.keyCreate'))}</button></div>`}
            </div>
            <div class="setup-step">
              <h4>${esc(t('connections.step2'))}</h4>
              <p class="row-sub">${esc(summaryOf(c))}</p>
              <ol class="pipeline">
                ${stepsOf(c).map(step => `<li><span>${esc(step)}</span></li>`).join('')}
              </ol>
              <pre class="code-block" data-config-code="${attr(c.provider)}">${esc(configText)}</pre>
              <div class="btn-row">
                <button type="button" class="btn small" data-copy-config="${attr(c.provider)}">${esc(t('connections.copy'))}</button>
                <button type="button" class="btn small" data-copy-endpoint>${esc(t('connections.modalCopyEndpoint'))}</button>
                ${c.provider === 'cursor' ? `<button type="button" class="btn small" data-copy-config="cursor">${esc(t('connections.modalCopyCursor'))}</button>` : ''}
                <span class="row-sub dim">${esc(freshKey ? t('connections.keyUseInConfig') : t('connections.keyPlaceholderHint'))}</span>
              </div>
            </div>
            <div class="setup-step">
              <h4>${esc(t('connections.step3'))}</h4>
              <p class="row-sub">${esc(t('connections.step3Body'))}</p>
              <div class="btn-row">
                <button type="button" class="btn small primary" data-test-memory="${attr(c.provider)}"${busyTest === c.provider || api.isDemo() ? ' disabled' : ''}>${esc(busyTest === c.provider ? t('connections.testing') : t('connections.testConnection'))}</button>
                ${connectionChip(c.connectionStatus)}
              </div>
              ${lastTest[c.provider] ? `<p class="row-sub ${lastTest[c.provider].ok ? 'good-text' : 'warn-text'}">${esc(lastTest[c.provider].message)}${lastTest[c.provider].ok ? '' : ' ' + esc(t('connections.testNext'))}</p>` : ''}
            </div>
            <p class="row-title mt">${esc(t('connections.autoSetup'))}</p>
            <p class="row-sub">${esc(t('connections.autoSetupBody'))}</p>
            <pre class="code-block" data-config-code="cli-${attr(c.provider)}">${esc(cliCommand(c, data?.gateway?.url ?? ''))}</pre>
            <div class="btn-row">
              <button type="button" class="btn small" data-copy-config="cli-${attr(c.provider)}">${esc(t('connections.copy'))}</button>
            </div>
            <p class="row-title mt">${esc(t('connections.promptsIntro'))}</p>
            <p class="row-sub"><b>${esc(t('connections.startWithDamc'))}</b></p>
            <pre class="code-block" data-config-code="prompt-start">${esc(t('connections.startPrompt'))}</pre>
            <div class="btn-row">
              <button type="button" class="btn small" data-copy-config="prompt-start">${esc(t('connections.copy'))}</button>
            </div>
            <p class="row-sub mt"><b>${esc(t('connections.continueWithDamc'))}</b></p>
            <pre class="code-block" data-config-code="prompt-continue">${esc(t('connections.continuePrompt'))}</pre>
            <div class="btn-row">
              <button type="button" class="btn small" data-copy-config="prompt-continue">${esc(t('connections.copy'))}</button>
            </div>
            <p class="row-title mt">${esc(t('connections.copySkill'))}</p>
            <pre class="code-block" data-config-code="skill">${esc(skillText ?? t('connections.loading'))}</pre>
            <div class="btn-row">
              <button type="button" class="btn small" data-copy-config="skill"${skillText ? '' : ' disabled'}>${esc(t('connections.copy'))}</button>
            </div>
            <p class="row-sub dim mt">${esc(c.setupDoc)} · ${esc(c.docs)}</p>
          </div>
        </div>`;
    };

    // ----------------------------------------------------------- API keys

    const keyRow = k => `
      <tr>
        <td>${esc(k.label)}</td>
        <td><code>${esc(k.prefix)}…</code></td>
        <td title="${esc(dateTime(k.createdAt))}">${esc(relative(k.createdAt))}</td>
        <td>${k.lastUsedAt ? esc(relative(k.lastUsedAt)) : '—'}</td>
        <td>${k.revokedAt ? badge('revoked', 'muted') : badge('active', 'good')}</td>
        <td>${k.revokedAt ? '' : `<button type="button" class="btn small" data-revoke-key="${attr(k.id)}"${busyKey === k.id ? ' disabled' : ''}>${esc(t('connections.keyRevoke'))}</button>`}</td>
      </tr>`;

    const apiKeysCard = () => `
      <section class="card" aria-label="${attr(t('connections.keysTitle'))}">
        ${sectionTitle(t('connections.keysTitle'))}
        <p class="row-sub">${esc(t('connections.keysIntro'))}</p>
        ${region(keys, data => (data?.keys ?? []).length ? `
          <div class="table-scroll mt">
            <table class="table">
              <thead><tr>
                <th scope="col">${esc(t('connections.keyLabel'))}</th>
                <th scope="col">${esc(t('connections.keyPrefix'))}</th>
                <th scope="col">${esc(t('connections.keyCreated'))}</th>
                <th scope="col">${esc(t('connections.keyLastUsed'))}</th>
                <th scope="col">${esc(t('connections.keyStatus'))}</th>
                <th scope="col"></th>
              </tr></thead>
              <tbody>${(data.keys ?? []).map(keyRow).join('')}</tbody>
            </table>
          </div>` : `<p class="row-sub dim mt">${esc(t('connections.keysEmpty'))}</p>`,
        { loading: t('connections.loading'), retry: 'reload-sync-center', empty: t('connections.keysEmpty') })}
        <div class="btn-row mt">
          <input id="new-key-label" type="text" class="field" style="max-width:220px" placeholder="${attr(t('connections.keyLabelPlaceholder'))}" value="${attr(newKeyLabel)}" aria-label="${attr(t('connections.keyLabel'))}">
          <button type="button" class="btn primary small" id="btn-key-create"${busyKey === 'create' ? ' disabled' : ''}>${esc(t('connections.keyCreate'))}</button>
        </div>
        ${freshKey ? `
          <div class="notice good mt" role="status">
            <b>${esc(t('connections.keyFreshTitle'))}</b><br>
            <code class="code-block" id="fresh-key">${esc(freshKey)}</code>
            <div class="btn-row mt">
              <button type="button" class="btn small" id="btn-copy-key">${esc(t('connections.copy'))}</button>
              <button type="button" class="btn small" id="btn-dismiss-key">${esc(t('connections.keyDismiss'))}</button>
            </div>
            <p class="row-sub dim mt">${esc(t('connections.keyFreshNote', { label: freshKeyLabel ?? '' }))}</p>
          </div>` : ''}
      </section>`;

    function goImport(provider) {
      if (provider) { state.importer.provider = provider; state.importer.preview = null; state.importer.result = null; }
      location.hash = '#/import';
    }

    // ---------------------------------------------------------------- cards

    const providerCard = p => {
      const busy = busyProvider === p.provider;
      const caps = p.capabilities ?? {};
      return `
        <article class="sync-provider" aria-label="${attr(p.label)}">
          <div class="sync-provider-head">
            <h4 class="connector-name">${esc(p.label)}</h4>
            <span class="conn-state ${p.connected ? 'on' : 'off'}"><span class="dot"></span>${esc(p.connected ? t('connections.stateOn') : t('connections.stateOff'))}</span>
          </div>
          <ul class="cap-list">
            ${CAPABILITY_ROWS.map(([key, labelKey]) => `
              <li><span>${esc(t(labelKey))}</span><span class="${caps[key] ? 'cap-yes' : 'cap-no'}">${esc(caps[key] ? t('connections.capYes') : t('connections.capNo'))}</span></li>`).join('')}
          </ul>
          <p class="row-sub dim">${p.lastActivity?.at
            ? esc(t('connections.lastImport', { when: relative(p.lastActivity.at) })) + ' · ' + esc(p.lastActivity.summary ?? '')
            : esc(t('connections.noImport'))}</p>
          <div class="btn-row">
            <button type="button" class="btn${p.connected ? '' : ' primary'} small" data-toggle-connect="${attr(p.provider)}" data-connected="${p.connected ? '1' : '0'}"${busy ? ' disabled' : ''}>
              ${esc(busy ? t('connections.working') : p.connected ? t('connections.disconnect') : t('connections.connect'))}
            </button>
            <button type="button" class="btn small" data-import-provider="${attr(p.provider)}">${esc(t('connections.import'))}</button>
          </div>
        </article>`;
    };

    const aiConnectionsCard = () => `
      <section class="card" aria-label="${attr(t('connections.aiTitle'))}">
        ${sectionTitle(t('connections.aiTitle'))}
        ${region(status, data => `
          <div class="provider-grid">
            ${(data.providers ?? []).filter(p => p.kind === 'ai_provider').map(providerCard).join('')}
          </div>`, { loading: t('connections.loading'), retry: 'reload-sync-center', empty: t('connections.none') })}
      </section>`;

    const autoImportCard = () => `
      <section class="card" aria-label="${attr(t('connections.autoTitle'))}">
        ${region(status, data => {
          const wf = data.watchFolder ?? { running: false, dir: '—' };
          return `
            ${sectionTitle(t('connections.autoTitle'), `<span class="conn-state ${wf.running ? 'on' : 'off'}"><span class="dot"></span>${esc(wf.running ? t('connections.watching') : t('connections.notWatching'))}</span>`)}
            <p class="row-sub"><code>${esc(wf.dir)}</code></p>
            <div class="btn-row mt">
              <a class="btn small" href="file:///${encodeURI(String(wf.dir).replace(/\\/g, '/'))}" target="_blank" rel="noopener">${esc(t('connections.openFolder'))}</a>
              <button type="button" class="btn small" data-import-provider="">${esc(t('connections.manageImport'))}</button>
            </div>
            <p class="row-sub dim mt">${esc(t('connections.autoHint'))}</p>`;
        }, { loading: t('connections.loading'), retry: 'reload-sync-center', empty: t('connections.none') })}
      </section>`;

    const recentSyncCard = () => `
      <section class="card" aria-label="${attr(t('connections.recentTitle'))}">
        ${sectionTitle(t('connections.recentTitle'), `<button type="button" class="btn small" data-goto="sync">${esc(t('connections.recentAll'))}</button>`)}
        ${region(jobs, rows => rows.length ? `
          <div class="table-scroll">
            <table class="table">
              <thead><tr>
                <th scope="col">${esc(t('sync.colProvider'))}</th>
                <th scope="col">${esc(t('sync.colStarted'))}</th>
                <th scope="col">${esc(t('sync.colImported'))}</th>
                <th scope="col">${esc(t('sync.colSkipped'))}</th>
                <th scope="col">${esc(t('sync.colMemories'))}</th>
                <th scope="col">${esc(t('sync.colStatus'))}</th>
              </tr></thead>
              <tbody>${rows.map(j => `
                <tr class="${j.status === 'failed' ? 'row-bad' : ''}">
                  <td>${esc(j.connector)}</td>
                  <td title="${esc(dateTime(j.startedAt ?? j.createdAt))}">${esc(relative(j.startedAt ?? j.createdAt))}</td>
                  <td>${num(j.stats?.imported, '0')}</td>
                  <td>${num(j.stats?.deduplicated, '0')}</td>
                  <td>${num(j.stats?.memoriesCreated, '0')}</td>
                  <td>${badge(j.status)}</td>
                </tr>`).join('')}</tbody>
            </table>
          </div>` : `<p class="row-sub dim">${esc(t('connections.recentEmpty'))}</p>`,
        { loading: t('connections.loading'), retry: 'reload-sync-center', empty: t('connections.recentEmpty') })}
      </section>`;

    const commonMemoryCard = () => `
      <section class="card" aria-label="${attr(t('connections.memoryTitle'))}">
        ${sectionTitle(t('connections.memoryTitle'), `<button type="button" class="btn small" data-goto="memory">${esc(t('connections.viewMemories'))}</button>`)}
        ${region(stats, d => `
          <div class="stat-row">
            <div class="stat"><div class="stat-label">${esc(t('connections.statMemories'))}</div><div class="stat-num">${num(d.memory?.total, '0')}</div></div>
            <div class="stat"><div class="stat-label">${esc(t('connections.statDecisions'))}</div><div class="stat-num">${num(d.memory?.decisions, '0')}</div></div>
            <div class="stat"><div class="stat-label">${esc(t('connections.statTasks'))}</div><div class="stat-num">${num(d.memory?.tasks, '0')}</div></div>
            <div class="stat"><div class="stat-label">${esc(t('connections.statProjects'))}</div><div class="stat-num">${num(d.projects?.total, '0')}</div></div>
            <div class="stat"><div class="stat-label">${esc(t('connections.statConversations'))}</div><div class="stat-num">${num(d.conversations?.total, '0')}</div></div>
          </div>`, { loading: t('connections.loading'), retry: 'reload-sync-center', empty: t('connections.none') })}
      </section>`;

    /** Everything that is detail rather than status: the non-AI integrations, the channel list, the policy text. */
    const detailsCard = () => `
      ${region(status, data => `
        <details class="card">
          <summary class="detail-summary">${esc(t('connections.detailsTitle'))}</summary>
          ${(data.providers ?? []).map(p => `
            <div class="connector">
              <div class="connector-head">
                <div>
                  <h4 class="connector-name">${esc(p.label)}</h4>
                  ${p.connected !== null ? badge(p.connected ? 'connected' : 'disconnected', p.connected ? 'good' : 'muted') : ''}
                </div>
              </div>
              <ul class="channel-list">${(p.channels ?? []).map(ch => `
                <li class="channel">
                  <div class="channel-main">
                    <p class="channel-label">${esc(channelLabel(ch))}</p>
                    <p class="row-sub">${esc(ch.detail)}</p>
                  </div>
                  <span class="chip chip-${attr(ch.state)}">${esc(STATE_LABEL[ch.state] ? t(STATE_LABEL[ch.state]) : ch.state)}</span>
                </li>`).join('')}</ul>
            </div>`).join('')}
          ${sectionTitle(t('connections.policy'))}
          <p class="row-sub">${esc(data.policy ?? '')}</p>
          <p class="row-sub dim mt">${esc(data.note ?? '')}</p>
        </details>`, { loading: '', retry: 'reload-sync-center', empty: '' })}`;

    const demoCard = () => `
      <section class="card" aria-label="${attr(t('connections.demoTitle'))}">
        ${sectionTitle(t('connections.demoTitle'))}
        <p class="row-sub">${esc(t('connections.demoBody'))}</p>
        <div class="btn-row mt"><button type="button" class="btn primary small" data-goto="settings">${esc(t('connections.demoGoSettings'))}</button></div>
      </section>`;

    const paint = () => {
      root.innerHTML = `
        <section class="card sync-hero">
          <h3 class="connector-name">${esc(t('connections.heroTitle'))}</h3>
          <p class="row-sub">${esc(t('connections.heroBody'))}</p>
        </section>
        <div class="toolbar"><button type="button" class="btn" id="conn-reload"${api.isDemo() ? ' disabled' : ''}>${esc(t('connections.reload'))}</button></div>
        ${api.isDemo() ? `
          ${demoCard()}
          ${aiHubCard()}` : `
          ${onboardingCard()}
          ${aiHubCard()}
          ${activityCard()}
          ${remoteAccessCard()}
          ${apiKeysCard()}
          ${aiConnectionsCard()}
          ${autoImportCard()}
          ${recentSyncCard()}
          ${commonMemoryCard()}
          ${detailsCard()}
          ${setupModal()}`}`;
      wire();
    };

    const wire = () => {
      root.querySelector('#conn-reload')?.addEventListener('click', load);
      root.querySelectorAll('[data-action="reload-sync-center"]').forEach(b => b.addEventListener('click', load));
      root.querySelectorAll('[data-toggle-connect]').forEach(btn =>
        btn.addEventListener('click', () => toggleConnection(btn.dataset.toggleConnect, btn.dataset.connected === '1')));
      root.querySelectorAll('[data-import-provider]').forEach(btn =>
        btn.addEventListener('click', () => goImport(btn.dataset.importProvider)));
      root.querySelectorAll('[data-goto]').forEach(btn => btn.addEventListener('click', () => { location.hash = `#/${btn.dataset.goto}`; }));

      // Setup dialog. The shared skill is fetched once per opening so Copy
      // Skill always carries the backend's current text, never a stale copy.
      root.querySelectorAll('[data-toggle-modal]').forEach(btn =>
        btn.addEventListener('click', () => {
          setupModalFor = btn.dataset.toggleModal;
          skillText = null;
          paint();
          api.getSkill().then(s => { skillText = s.content; paint(); }).catch(() => { skillText = ''; paint(); });
        }));
      root.querySelector('#modal-close')?.addEventListener('click', () => { setupModalFor = null; paint(); });
      root.querySelector('#modal-scrim')?.addEventListener('click', e => {
        if (e.target.id === 'modal-scrim') { setupModalFor = null; paint(); }
      });
      // Step 1 of the dialog: create the key right here, labelled after the AI,
      // and keep the dialog open so the config below re-renders with the key in
      // it. Sending the user off to the key manager and back was the single most
      // confusing moment on this screen.
      root.querySelector('#modal-create-key')?.addEventListener('click', async () => {
        busyKey = 'create'; paint();
        try {
          const created = await api.createApiKey(`${setupModalFor}-${new Date().toISOString().slice(0, 10)}`);
          freshKey = created.key; freshKeyLabel = created.label;
          toast(t('connections.keyCreatedToast', { label: created.label }), 'good');
          busyKey = null;
          await load();
          return;
        } catch (error) { toast(error.message, 'bad'); }
        busyKey = null; paint();
      });

      // Test Memory: real DAMC reads, never a health ping. Success reports the
      // counts the backend actually returned (project pack + memory totals);
      // failures show the real error — never a canned "connected" message.
      root.querySelectorAll('[data-test-memory]').forEach(btn =>
        btn.addEventListener('click', async () => {
          const provider = btn.dataset.testMemory;
          busyTest = provider; paint();
          try {
            const [pack, dash] = await Promise.all([api.getContextPack(), api.getDashboard()]);
            const counts = pack.counts ?? {};
            const message = t('connections.testResultOk', {
              decisions: counts.activeDecisions ?? 0,
              tasks: counts.activeTasks ?? 0,
              memories: dash.memory?.total ?? 0
            });
            lastTest[provider] = { ok: true, message, at: Date.now() };
            toast(message, 'good');
          } catch (error) {
            const message = t('connections.testResultFail', { message: error.message });
            lastTest[provider] = { ok: false, message, at: Date.now() };
            toast(message, 'bad');
          }
          busyTest = null;
          // Re-read status so the chip reflects whatever the audit trail now says.
          // The test itself is a dashboard-side read; it does not make the AI ACTIVE.
          await load();
        }));

      // Copy actions: endpoint and provider configs.
      root.querySelectorAll('[data-copy-endpoint]').forEach(btn =>
        btn.addEventListener('click', async () => {
          const url = remote.data?.endpoint ?? (status.data?.gateway?.url ?? '');
          try { await navigator.clipboard.writeText(url); toast(t('connections.copied'), 'good'); }
          catch { toast(url, 'info'); }
        }));
      root.querySelectorAll('[data-copy-config]').forEach(btn =>
        btn.addEventListener('click', async () => {
          const text = root.querySelector(`[data-config-code="${btn.dataset.copyConfig}"]`)?.textContent ?? '';
          try { await navigator.clipboard.writeText(text); toast(t('connections.copied'), 'good'); }
          catch { toast(text.slice(0, 120), 'info'); }
        }));

      // Remote Access.
      root.querySelector('#btn-remote-toggle')?.addEventListener('click', async () => {
        busyRemote = true; paint();
        try {
          const next = remote.data?.enabled ? await api.disableRemoteAccess() : await api.enableRemoteAccess();
          remote = ready(next);
          toast(next.enabled ? t('connections.remoteEnabledToast', { endpoint: next.endpoint ?? '' }) : t('connections.remoteDisabledToast'), next.enabled ? 'good' : 'info');
        } catch (error) { toast(error.message, 'bad'); }
        busyRemote = false;
        await load();
      });
      root.querySelector('#btn-remote-verify')?.addEventListener('click', async () => {
        busyRemote = true; verifyResult = null; paint();
        try { verifyResult = await api.verifyRemoteAccess(remote.data?.endpoint ?? ''); }
        catch (error) { verifyResult = { ok: false, message: error.message }; }
        busyRemote = false;
        paint();
      });

      // First-run: create the first project inline.
      root.querySelector('#onboard-project-form')?.addEventListener('submit', async e => {
        e.preventDefault();
        const name = (root.querySelector('#onboard-project')?.value ?? '').trim();
        if (!name) return;
        try {
          await api.createProject(name);
          toast(t('connections.onbCreated', { name }), 'good');
          await load();
        } catch (error) { toast(error.message, 'bad'); }
      });

      // API keys.
      root.querySelector('#btn-key-create')?.addEventListener('click', async () => {
        busyKey = 'create'; paint();
        try {
          const label = (root.querySelector('#new-key-label')?.value ?? '').trim() || 'default';
          const created = await api.createApiKey(label);
          busyKey = null; newKeyLabel = '';
          freshKey = created.key; freshKeyLabel = created.label;
          toast(t('connections.keyCreatedToast', { label: created.label }), 'good');
          await load();
          return;
        } catch (error) { toast(error.message, 'bad'); }
        busyKey = null; paint();
      });
      root.querySelector('#btn-copy-key')?.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(freshKey ?? ''); toast(t('connections.copied'), 'good'); }
        catch { /* clipboard unavailable — the key stays visible on screen */ }
      });
      root.querySelector('#btn-dismiss-key')?.addEventListener('click', () => { freshKey = null; freshKeyLabel = null; paint(); });
      root.querySelectorAll('[data-revoke-key]').forEach(btn =>
        btn.addEventListener('click', async () => {
          busyKey = btn.dataset.revokeKey; paint();
          try {
            await api.revokeApiKey(busyKey);
            if (freshKey) { freshKey = null; freshKeyLabel = null; }
            toast(t('connections.keyRevokedToast'), 'good');
          } catch (error) { toast(error.message, 'bad'); }
          busyKey = null;
          await load();
        }));
    };

    paint();
    await load();
  }
};
