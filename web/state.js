/** Minimal observable app state. No framework. */

import { loadSettings, saveSettings } from './api.js';
import { setLanguage as applyI18nLanguage, detectLanguage, isSupported } from './i18n.js';

const listeners = new Set();

export const state = {
  route: 'overview',
  sidebarOpen: false,
  theme: loadSettings().theme || 'light',
  language: (() => {
    const saved = loadSettings().language;
    return isSupported(saved) ? saved : detectLanguage(typeof navigator === 'undefined' ? '' : navigator.language);
  })(),
  // Cached reference data shared by several pages.
  projects: { status: 'idle', data: null, error: null },
  providers: { status: 'idle', data: null, error: null },
  // Per-page view state, preserved while navigating between pages.
  memory: { q: '', projectId: '', status: '', provider: '', minImportance: '', sort: 'newest', selectedId: null },
  currentState: { projectId: '' },
  importer: {
    provider: 'chatgpt', file: null, preview: null, result: null, busy: false, error: null,
    // Live server-side progress while an upload is in flight, the completion
    // banner rebuilt from the last job row after a reload, and the poll handle.
    progress: null, progressTimer: null, justFinished: false, restored: null, finishedAt: null,
    // A Claude export manifest the user dropped in: the summary of what it lists,
    // and the running manifest job once one has been started.
    manifest: null, manifestJob: null, manifestJobId: null,
    // The browser-download session: the packages the user is fetching, the watch
    // folder state they have to act on, and the export URLs themselves — which
    // live here, in this tab, and are deliberately never sent to the server.
    session: null, sessionJobId: null, sessionWatcher: null, sessionTimer: null,
    packageUrls: null, reattached: false
  }
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify() {
  for (const fn of listeners) fn(state);
}

export function setRoute(route) {
  state.route = route;
  state.sidebarOpen = false;
  notify();
}

export function setTheme(theme) {
  state.theme = theme;
  saveSettings({ theme });
  applyTheme();
  notify();
}

export function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
}

export function setLanguage(language) {
  state.language = applyI18nLanguage(language);
  saveSettings({ language: state.language });
  applyLanguage();
  notify();
}

/** Push the chosen language into the translator and onto <html lang>. */
export function applyLanguage() {
  applyI18nLanguage(state.language);
  document.documentElement.lang = state.language;
}

/** Async result wrapper used by every page: { status, data, error }. */
export function idle() { return { status: 'idle', data: null, error: null }; }
export function loading() { return { status: 'loading', data: null, error: null }; }
export function ready(data) { return { status: 'ready', data, error: null }; }
export function failed(error) { return { status: 'error', data: null, error }; }

/**
 * Run a loader and push its three states through `onChange`.
 * Stale responses are dropped using a monotonic token.
 */
export function track(loader, onChange, tokenRef) {
  const token = (tokenRef.current = (tokenRef.current ?? 0) + 1);
  onChange(loading());
  return loader()
    .then(data => { if (token === tokenRef.current) onChange(ready(data)); })
    .catch(error => { if (token === tokenRef.current) onChange(failed(error)); });
}
