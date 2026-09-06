/**
 * DOM helpers and shared chrome: element builder, toasts, modals, confirm
 * dialog, slide-over panels, copy buttons, Esc handling and the app-wide
 * event bus.
 * @module ui
 */

/** App-wide event bus: 'container', 'containers-changed', 'job', 'image', 'events-state'. */
export const bus = new EventTarget();

/** Dispatch a bus event. @param {string} type @param {any} [detail] */
export function emit(type, detail) {
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}

const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'readOnly', 'indeterminate']);

/**
 * Create an element. `attrs` keys: `class`, `text`, `dataset`, `on<Event>`
 * handlers, property names in PROPS, everything else via setAttribute
 * (`true` → empty attribute, `false`/null → skipped).
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...any} children strings, nodes, arrays or null
 * @returns {HTMLElement}
 */
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (PROPS.has(k)) node[k] = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(node, children);
  return node;
}

/**
 * Append children (nested arrays, strings, numbers, nodes; null/false skipped).
 * @param {Node} node
 * @param {any} children
 */
export function append(node, children) {
  for (const c of Array.isArray(children) ? children : [children]) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(node, c);
    else if (c instanceof Node) node.appendChild(c);
    else node.appendChild(document.createTextNode(String(c)));
  }
}

/** Remove all children. @param {Node} node */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

const ICONS = {
  copy: '<rect x="9" y="9" width="11" height="11" rx="1.5"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  down: '<path d="M12 5v14M5 12l7 7 7-7"/>',
};

/**
 * Inline SVG icon (stroke follows currentColor).
 * @param {'copy'|'close'|'chevron'|'down'} name
 */
export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || '';
  if (name === 'chevron') svg.classList.add('chevron');
  return svg;
}

/**
 * Status badge.
 * @param {string} text
 * @param {'ok'|'warn'|'bad'|'muted'|'info'} kind
 * @param {string} [title]
 */
export function badge(text, kind, title) {
  return el('span', { class: `badge ${kind}`, title }, text);
}

/** Small spinner element. */
export function spinner() {
  return el('span', { class: 'spinner', 'aria-hidden': 'true' });
}

/**
 * Copy text to the clipboard (falls back to a hidden textarea) and toast.
 * @param {string} text
 * @param {string} [label='Copied']
 */
export async function copyText(text, label = 'Copied') {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = el('textarea', { class: 'sr-only', value: text, 'aria-hidden': 'true' });
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(label, { kind: 'success', timeout: 1800 });
  } catch (err) {
    toast(`Copy failed: ${err.message}`, { kind: 'error' });
  }
}

/**
 * Icon-only copy button.
 * @param {string} text value to copy
 * @param {string} what description for the aria-label ("flow id")
 */
export function copyButton(text, what) {
  return el('button', { class: 'btn icon ghost', type: 'button', 'aria-label': `Copy ${what}`, title: `Copy ${what}`, onClick: (e) => { e.stopPropagation(); copyText(text, `${what} copied`); } }, icon('copy'));
}

/* ---------- toasts ---------- */

/**
 * Show a toast. Identical messages already on screen are not duplicated.
 * @param {string} message
 * @param {{ kind?: 'info'|'success'|'error', timeout?: number }} [opts]
 */
export function toast(message, { kind = 'info', timeout = kind === 'error' ? 8000 : 4000 } = {}) {
  const root = document.getElementById('toasts');
  if (!root) return;
  const existing = Array.from(root.children).find((t) => t.dataset.message === message);
  if (existing) {
    existing.remove();
  }
  const node = el('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status', dataset: { message } },
    el('span', { text: message }),
    el('button', { class: 'btn icon ghost', type: 'button', 'aria-label': 'Dismiss', onClick: () => node.remove() }, icon('close')));
  root.appendChild(node);
  while (root.children.length > 5) root.firstChild.remove();
  setTimeout(() => node.remove(), timeout);
}

/* ---------- layers (panels + modals share one Esc stack) ---------- */

/** @type {Array<{ root: HTMLElement, close: () => void, prevFocus: Element|null }>} */
const layers = [];

function pushLayer(layer) {
  layers.push(layer);
  queueMicrotask(() => {
    const target = layer.root.querySelector('[data-autofocus]') || layer.root.querySelector('input, select, textarea, button');
    if (target instanceof HTMLElement) target.focus();
  });
}

function popLayer(layer) {
  const i = layers.indexOf(layer);
  if (i >= 0) layers.splice(i, 1);
  layer.root.remove();
  const prev = layer.prevFocus;
  if (prev instanceof HTMLElement && document.contains(prev)) prev.focus();
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || layers.length === 0) return;
  // Let the terminal keep Esc for the shell/editor running inside it.
  if (e.target instanceof Element && e.target.closest('.xterm')) return;
  e.preventDefault();
  layers[layers.length - 1].close();
});

/**
 * Open a slide-over panel on the right.
 * @param {{ title: string, subtitle?: string, className?: string, onClose?: () => void }} opts
 * @returns {{ root: HTMLElement, head: HTMLElement, body: HTMLElement, close: () => void, setSubtitle: (s: string) => void }}
 */
export function openPanel({ title, subtitle = '', className = '', onClose }) {
  const host = document.getElementById('panels');
  const sub = el('span', { class: 'sub mono', text: subtitle });
  const body = el('div', { class: 'panel-body' });
  const head = el('div', { class: 'panel-head' }, el('h2', { text: title }), sub, el('span', { class: 'spacer' }));
  const root = el('aside', { class: `panel ${className}`, role: 'dialog', 'aria-label': title }, head, body);
  const layer = { root, prevFocus: document.activeElement, close };
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    try {
      if (onClose) onClose();
    } finally {
      popLayer(layer);
    }
  }
  head.appendChild(el('button', { class: 'btn icon ghost', type: 'button', 'aria-label': 'Close panel', title: 'Close (Esc)', onClick: close }, icon('close')));
  host.appendChild(root);
  pushLayer(layer);
  return { root, head, body, close, setSubtitle: (s) => { sub.textContent = s; } };
}

/**
 * Open a modal dialog.
 * @param {{ title: string, className?: string, dismissible?: boolean, onClose?: () => void }} opts
 * @returns {{ root: HTMLElement, body: HTMLElement, foot: HTMLElement, titleEl: HTMLElement, close: () => void }}
 */
export function openModal({ title, className = '', dismissible = true, onClose }) {
  const host = document.getElementById('modals');
  const titleEl = el('h2', { id: `modal-title-${Date.now()}`, text: title });
  const body = el('div', { class: 'modal-body' });
  const foot = el('div', { class: 'modal-foot' });
  const modal = el('div', { class: `modal ${className}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleEl.id },
    el('div', { class: 'modal-head' }, titleEl, el('button', { class: 'btn icon ghost', type: 'button', 'aria-label': 'Close dialog', title: 'Close (Esc)', onClick: () => close() }, icon('close'))),
    body, foot);
  const root = el('div', { class: 'modal-backdrop', onMousedown: (e) => { if (dismissible && e.target === root) close(); } }, modal);
  const layer = { root, prevFocus: document.activeElement, close };
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    try {
      if (onClose) onClose();
    } finally {
      popLayer(layer);
    }
  }
  host.appendChild(root);
  pushLayer(layer);
  return { root, body, foot, titleEl, close };
}

/**
 * Confirm dialog. Resolves true when confirmed.
 * @param {{ title: string, message: string|Node, confirmLabel?: string, danger?: boolean }} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const m = openModal({ title, onClose: () => resolve(result) });
    append(m.body, typeof message === 'string' ? el('p', { text: message }) : message);
    m.foot.append(
      el('button', { class: 'btn', type: 'button', onClick: () => m.close() }, 'Cancel'),
      el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', 'data-autofocus': true, onClick: () => { result = true; m.close(); } }, confirmLabel),
    );
  });
}

/**
 * Ask for the access token (used by api.js on 401). Resolves with the token
 * or null when cancelled.
 * @returns {Promise<string|null>}
 */
export function promptToken() {
  return new Promise((resolve) => {
    let value = null;
    const input = el('input', { type: 'password', class: 'mono', autocomplete: 'off', placeholder: 'EASY_MXL_TOKEN', 'aria-label': 'Access token', 'data-autofocus': true });
    const m = openModal({ title: 'Access token required', dismissible: false, onClose: () => resolve(value) });
    const form = el('form', { onSubmit: (e) => { e.preventDefault(); value = input.value.trim() || null; m.close(); } },
      el('p', { class: 'muted' }, 'The server rejected the request (401). Enter the token configured with --token / EASY_MXL_TOKEN. It is stored in this browser only.'),
      el('div', { class: 'field' }, input));
    m.body.appendChild(form);
    m.foot.append(
      el('button', { class: 'btn', type: 'button', onClick: () => m.close() }, 'Cancel'),
      el('button', { class: 'btn primary', type: 'button', onClick: () => form.requestSubmit() }, 'Save token'),
    );
  });
}

/**
 * Turn an error into a toast; returns the message.
 * @param {unknown} err
 * @param {string} [prefix]
 */
export function toastError(err, prefix = '') {
  const msg = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
  toast(prefix ? `${prefix}: ${msg}` : msg, { kind: 'error' });
  return msg;
}
