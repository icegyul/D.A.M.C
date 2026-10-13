// Shared DOM/formatting helpers. No framework, no dependencies.

import { t } from './i18n.js';

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape anything that reaches innerHTML. Every interpolated value goes through this. */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, c => ENTITIES[c]);
}

export function attr(value) { return esc(value); }

const STATUS_TONE = {
  active: 'good', confirmed: 'good', completed: 'good', available: 'good', running: 'info',
  queued: 'info', candidate: 'warn', needs_configuration: 'warn', superseded: 'muted',
  deprecated: 'bad', archived: 'muted', failed: 'bad', not_available: 'muted',
  // 'partial' is a warning, not a neutral state: some conversations landed and
  // some did not. Without an entry it fell through to 'muted' and read like
  // 'archived'.
  partial: 'warn', watching: 'good', stopped: 'muted'
};

export function tone(status) { return STATUS_TONE[String(status)] ?? 'muted'; }

export function badge(text, toneOverride) {
  if (text === null || text === undefined || text === '') return '';
  return `<span class="badge ${toneOverride ?? tone(text)}">${esc(text)}</span>`;
}

/** Percentage from a 0..1 numeric column. Returns null when the value is absent. */
export function pct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function pctText(value, fallback = '—') {
  const p = pct(value);
  return p === null ? fallback : `${p}%`;
}

export function num(value, fallback = '—') {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString() : fallback;
}

export function bytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

export function dateTime(value, fallback = '—') {
  if (!value) return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return fallback;
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function relative(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60000);
  if (Math.abs(mins) < 1) return t('ui.justNow');
  if (Math.abs(mins) < 60) return t('ui.minutesAgo', { n: mins });
  const hours = Math.round(mins / 60);
  if (Math.abs(hours) < 24) return t('ui.hoursAgo', { n: hours });
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return t('ui.daysAgo', { n: days });
  return dateTime(value);
}

export function truncate(text, max = 180) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---------------------------------------------------------------------------
// Loading / Empty / Error blocks. Every data region on every page uses these.
// ---------------------------------------------------------------------------

export function loadingBlock(label) {
  label = label ?? t('ui.loading');
  return `<div class="state-block" role="status" aria-live="polite">
    <span class="spinner" aria-hidden="true"></span>
    <p>${esc(label)}</p>
  </div>`;
}

export function emptyBlock(label, hint = '') {
  label = label ?? t('ui.noData');
  return `<div class="state-block empty">
    <p class="state-title">${esc(label)}</p>
    ${hint ? `<p class="state-hint">${esc(hint)}</p>` : ''}
  </div>`;
}

export function errorBlock(error, retryAction) {
  const message = error?.message ?? t('ui.unexpectedError');
  const code = error?.code ? ` (${error.code})` : '';
  return `<div class="state-block error" role="alert">
    <p class="state-title">${esc(t('ui.unableToLoad'))}${esc(code)}</p>
    <p class="state-hint">${esc(message)}</p>
    ${retryAction ? `<button type="button" class="btn" data-action="${attr(retryAction)}">${esc(t('ui.retry'))}</button>` : ''}
  </div>`;
}

/**
 * Render a data region through its three states.
 * `render` is only called with a non-empty result.
 */
export function region(result, render, opts = {}) {
  if (result.status === 'loading') return loadingBlock(opts.loading);
  if (result.status === 'error') return errorBlock(result.error, opts.retry);
  const data = result.data;
  const isEmpty = Array.isArray(data) ? data.length === 0 : (data === null || data === undefined);
  if (isEmpty) return emptyBlock(opts.empty ?? 'No data yet.', opts.emptyHint);
  return render(data);
}

export function sectionTitle(text, right = '') {
  return `<div class="section-title"><span>${esc(text)}</span>${right}</div>`;
}

export function statTile(label, value, sub) {
  return `<div class="stat">
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-num">${typeof value === 'string' ? esc(value) : num(value)}</div>
    ${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ''}
  </div>`;
}

export function kv(pairs) {
  return `<dl class="kv">${pairs.map(([k, v, raw]) => `<dt>${esc(k)}</dt><dd>${raw ? v : esc(v ?? '—')}</dd>`).join('')}</dl>`;
}

/** Build a <select>. `options` is [{value,label}]. */
export function select({ id, label, value, options, ariaLabel }) {
  return `<label class="field">
    ${label ? `<span class="field-label">${esc(label)}</span>` : ''}
    <select id="${attr(id)}" ${ariaLabel ? `aria-label="${attr(ariaLabel)}"` : ''}>
      ${options.map(o => `<option value="${attr(o.value)}"${String(o.value) === String(value ?? '') ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
    </select>
  </label>`;
}

/** Transient toast used only to report the outcome of a real backend call. */
export function toast(message, kind = 'info') {
  let host = document.getElementById('damc-toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'damc-toasts';
    host.className = 'toasts';
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 250); }, 4200);
}
