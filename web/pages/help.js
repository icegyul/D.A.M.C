import { esc, sectionTitle } from '../ui.js';
import { t } from '../i18n.js';

/**
 * In-app help — self-contained on purpose.
 *
 * A first-time user must be able to understand and use DAMC from this screen
 * alone: what it is, what it stores, how to fill it, how to connect an AI, why
 * Obsidian, where the data lives and what happens to it on reinstall. It never
 * sends the user to the docs folder for anything a user needs; docs/ stays the
 * developer and deployment reference and is mentioned only as that.
 *
 * Static by design: no backend call, so it works on a fresh install before a key
 * exists, while the container is still starting, and when something is broken —
 * which is when help is opened. The one live value, the MCP address, is derived
 * from this page's own origin.
 */

/** Section id → row keys. Order follows the user's first day, not the feature list. */
const SECTIONS = [
  ['what',    ['whatIs', 'whatStores', 'whatWhy', 'whatRoles']],
  ['start',   ['startDocker', 'startInstall', 'startFirst', 'startNext']],
  ['import',  ['importChatgpt', 'importClaude', 'importClaudeFolder', 'importDone', 'importDup']],
  ['types',   ['typeMemory', 'typeDecision', 'typeTask', 'typeConversation', 'typeCandidate']],
  ['connect', ['connectWhat', 'connectMcp', 'connectSteps', 'connectStates', 'connectNoDetect']],
  ['hermes',  ['hermes1', 'hermes2', 'hermes3', 'hermes4']],
  ['obsidian',['obsWhy', 'obsHow', 'obsRoles', 'obsOneWay']],
  ['data',    ['dataWhere', 'dataReinstall', 'dataUninstall', 'dataNoDemo', 'dataSecurity']],
  ['trouble', ['troubleDashboard', 'troubleDocker', 'troubleNoUse', 'troubleUnknown', 'troubleGateway', 'troubleCount']]
];

function rows(keys) {
  return `<ul class="help-list">${keys.map(k => `<li>${esc(t(`help.${k}`))}</li>`).join('')}</ul>`;
}

export default {
  id: 'help',

  async mount(root) {
    const endpoint = `${location.origin}/v1/mcp`;

    root.innerHTML = `
      <section class="card">
        ${sectionTitle(t('help.title'))}
        <p class="row-sub">${esc(t('help.model1'))}</p>
        <p class="row-sub">${esc(t('help.model2'))}</p>
        <p class="row-sub">${esc(t('help.model3'))}</p>
        <p class="row-sub">${esc(t('help.model4'))}</p>
        <div class="kv mt">
          <div><span>${esc(t('help.endpointLabel'))}</span><code>${esc(endpoint)}</code></div>
          <div><span>${esc(t('help.toolsLabel'))}</span><span>22</span></div>
        </div>
      </section>

      ${SECTIONS.map(([id, keys]) => `
        <section class="card">
          ${sectionTitle(t(`help.${id}`))}
          ${rows(keys)}
        </section>`).join('')}

      <section class="card">
        <p class="row-sub dim">${esc(t('help.devDocs'))}</p>
      </section>
    `;

    return () => { /* static page: nothing to tear down */ };
  }
};
