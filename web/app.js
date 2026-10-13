/**
 * DAMC dashboard shell: routing, connection banner, and page mounting.
 * Static ES modules only — no framework, no build step.
 */

import * as api from './api.js';
import { state, setRoute, applyTheme, applyLanguage, subscribe, notify } from './state.js';
import { esc, attr, dateTime } from './ui.js';
import { t } from './i18n.js';

import overview from './pages/overview.js';
import memory from './pages/memory.js';
import currentState from './pages/current-state.js';
import obsidian from './pages/obsidian.js';
import connections from './pages/connections.js';
import importer from './pages/import.js';
import sync from './pages/sync.js';
import settings from './pages/settings.js';
import help from './pages/help.js';

const PAGES = [overview, memory, currentState, obsidian, connections, importer, sync, settings, help];
const PAGE_BY_ID = new Map(PAGES.map(p => [p.id, p]));

const NAV = [
  { id: 'overview', icon: '⌂' },
  { id: 'memory', icon: '◈' },
  { id: 'current-state', icon: '◎' },
  { id: 'obsidian', icon: '◇' },
  { id: 'connections', icon: '⇄' },
  { id: 'import', icon: '↥' },
  { id: 'sync', icon: '↻' },
  { id: 'settings', icon: '⚙' },
  { id: 'help', icon: '?' }
];

const app = document.getElementById('app');
let currentMount = null;
let booting = true;

function routeFromHash() {
  const id = (location.hash || '').replace(/^#\/?/, '').trim();
  return PAGE_BY_ID.has(id) ? id : 'overview';
}

function connectionChip() {
  const c = api.connection;
  if (c.mode === 'live') {
    return `<span class="conn conn-live" title="${attr(t('conn.connectedTo', { origin: api.loadSettings().baseUrl || location.origin }))}">
      <span class="dot"></span>${esc(t('conn.live'))}</span>`;
  }
  if (c.mode === 'demo') {
    return `<span class="conn conn-demo" title="${attr(c.reason ?? t('conn.unreachable'))}"><span class="dot"></span>${esc(t('conn.demo'))}</span>`;
  }
  // Two states that used to be reported as demo mode. They are different problems
  // with different fixes, and neither is "here is some sample data".
  if (c.mode === 'offline') {
    return `<span class="conn conn-demo" title="${attr(c.reason ?? t('conn.unreachable'))}"><span class="dot"></span>${esc(t('conn.offline'))}</span>`;
  }
  if (c.mode === 'unauthenticated') {
    return `<span class="conn conn-demo" title="${attr(c.reason ?? '')}"><span class="dot"></span>${esc(t('conn.unauthenticated'))}</span>`;
  }
  return `<span class="conn conn-unknown"><span class="dot"></span>${esc(t('conn.checking'))}</span>`;
}

function shell() {
  const page = PAGE_BY_ID.get(state.route);
  app.innerHTML = `
    <a class="skip-link" href="#main-content">${esc(t('shell.skip'))}</a>
    <div class="shell${state.sidebarOpen ? ' sidebar-open' : ''}">
      <div class="scrim" id="scrim" hidden></div>
      <aside class="sidebar" id="sidebar" aria-label="${attr(t('shell.primaryNav'))}">
        <div class="brand">
          <span class="brand-name">DAMC</span>
          <span class="brand-sub">${esc(t('brand.sub'))}</span>
        </div>
        <nav class="nav" aria-label="${attr(t('shell.sections'))}">
          ${NAV.map(n => `<a class="nav-item${state.route === n.id ? ' active' : ''}" href="#/${attr(n.id)}"${state.route === n.id ? ' aria-current="page"' : ''}>
            <span class="nav-icon" aria-hidden="true">${n.icon}</span><span>${esc(t(`nav.${n.id}`))}</span>
          </a>`).join('')}
        </nav>
        <div class="sidebar-foot">
          <p class="sidebar-note">${esc(t('shell.sidebarNote'))}</p>
        </div>
      </aside>

      <div class="main">
        <header class="topbar">
          <button type="button" class="icon-btn menu-btn" id="menu-btn" aria-label="${attr(t('shell.openNav'))}" aria-expanded="${state.sidebarOpen}" aria-controls="sidebar">☰</button>
          <form class="topsearch" id="topsearch" role="search">
            <label class="sr-only" for="global-q">${esc(t('shell.searchLabel'))}</label>
            <input id="global-q" type="search" placeholder="${attr(t('shell.searchPlaceholder'))}" autocomplete="off">
          </form>
          <div class="topbar-actions">
            ${connectionChip()}
            <button type="button" class="icon-btn" id="recheck" aria-label="${attr(t('shell.recheck'))}">⟳</button>
            <a class="icon-btn hide-sm" href="#/settings" aria-label="${attr(t('shell.openSettings'))}">⚙</a>
          </div>
        </header>

        ${api.connection.mode === 'offline' ? `<div class="demo-banner" role="alert">
          <b>${esc(t('banner.offlineTitle'))}</b> — ${esc(t('banner.offlineBody'))}${api.connection.reason ? ` (${esc(api.connection.reason)})` : ''}
        </div>` : ''}
        ${api.connection.mode === 'unauthenticated' ? `<div class="demo-banner" role="alert">
          <b>${esc(t('banner.authTitle'))}</b> — ${esc(t('banner.authBody'))}
        </div>` : ''}
        ${api.connection.mode === 'demo' ? `<div class="demo-banner" role="status">
          <b>${esc(t('banner.demoTitle'))}</b> — ${esc(t('banner.demoBody'))}${api.connection.reason ? ` (${esc(api.connection.reason)})` : ''}.
          ${esc(t('banner.demoTail'))}
          <button type="button" class="link-btn" id="banner-recheck">${esc(t('banner.recheck'))}</button>
          <a class="link-btn" href="#/settings">${esc(t('banner.configure'))}</a>
        </div>` : ''}

        <main class="content" id="main-content" tabindex="-1">
          <div class="page-head">
            <div>
              <h1>${esc(t(`page.${page.id}.title`))}</h1>
              <p>${esc(t(`page.${page.id}.subtitle`))}</p>
            </div>
            <div class="page-head-meta">${api.connection.checkedAt ? esc(t('shell.checkedAt', { time: dateTime(api.connection.checkedAt) })) : ''}</div>
          </div>
          <div id="page-root">${booting ? `<div class="state-block" role="status"><span class="spinner" aria-hidden="true"></span><p>${esc(t('shell.checkingBackend'))}</p></div>` : ''}</div>
        </main>
      </div>
    </div>`;

  wireShell();
  if (!booting) mountPage(page);
}

/** Re-run the current page's mount, e.g. after the header search changes filters. */
function remountCurrent() {
  const page = PAGE_BY_ID.get(state.route);
  if (page && !booting) mountPage(page);
}

function wireShell() {
  const sidebar = document.getElementById('sidebar');
  const scrim = document.getElementById('scrim');
  const menuBtn = document.getElementById('menu-btn');

  const setSidebar = open => {
    state.sidebarOpen = open;
    document.querySelector('.shell')?.classList.toggle('sidebar-open', open);
    menuBtn?.setAttribute('aria-expanded', String(open));
    if (scrim) scrim.hidden = !open;
    if (open) sidebar?.querySelector('.nav-item')?.focus();
    else menuBtn?.focus();
  };

  menuBtn?.addEventListener('click', () => setSidebar(!state.sidebarOpen));
  scrim?.addEventListener('click', () => setSidebar(false));
  if (scrim) scrim.hidden = !state.sidebarOpen;

  sidebar?.querySelectorAll('.nav-item').forEach(a => a.addEventListener('click', () => { state.sidebarOpen = false; }));

  document.getElementById('topsearch')?.addEventListener('submit', event => {
    event.preventDefault();
    const value = document.getElementById('global-q').value;
    state.memory.q = value;
    state.memory.sort = value.trim() ? 'relevance' : 'newest';
    if (state.route === 'memory') remountCurrent();
    else location.hash = '#/memory';
  });

  document.getElementById('recheck')?.addEventListener('click', refreshConnection);
  document.getElementById('banner-recheck')?.addEventListener('click', refreshConnection);
}

async function mountPage(page) {
  const root = document.getElementById('page-root');
  currentMount = page.id;
  try {
    await page.mount(root, { refreshConnection, probeConnection, rerenderShell: () => shell() });
  } catch (error) {
    if (currentMount !== page.id) return;
    root.innerHTML = `<div class="state-block error" role="alert">
      <p class="state-title">${esc(t('shell.pageFailed'))}</p>
      <p class="state-hint">${esc(error?.message ?? String(error))}</p>
    </div>`;
  }
}

async function refreshConnection() {
  api.connection.mode = 'unknown';
  shellChromeOnly();
  await api.detectConnection();
  shell();
}

/**
 * Re-probe without discarding the mounted page.
 * Returns true when the live/demo mode changed and the page was remounted, so the
 * caller knows not to paint into a detached root.
 */
async function probeConnection() {
  const before = api.connection.mode;
  api.connection.mode = 'unknown';
  shellChromeOnly();
  await api.detectConnection();
  if (api.connection.mode !== before) { shell(); return true; }
  shellChromeOnly();
  return false;
}

/** Repaint only the connection chip while a probe is in flight. */
function shellChromeOnly() {
  const holder = document.querySelector('.topbar-actions .conn');
  if (holder) holder.outerHTML = connectionChip();
}

function onRouteChange() {
  const next = routeFromHash();
  if (next === state.route && document.getElementById('page-root')) return;
  setRoute(next);
  shell();
  document.getElementById('main-content')?.focus({ preventScroll: true });
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && state.sidebarOpen) {
    state.sidebarOpen = false;
    document.querySelector('.shell')?.classList.remove('sidebar-open');
    const scrim = document.getElementById('scrim');
    if (scrim) scrim.hidden = true;
    document.getElementById('menu-btn')?.focus();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    document.getElementById('global-q')?.focus();
  }
});

window.addEventListener('hashchange', onRouteChange);
subscribe(() => { applyTheme(); applyLanguage(); });

(async function boot() {
  applyTheme();
  applyLanguage();
  state.route = routeFromHash();
  shell();
  await api.detectConnection();
  booting = false;
  shell();
  notify();
})();
