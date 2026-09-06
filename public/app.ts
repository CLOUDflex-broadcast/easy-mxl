/**
 * Entry point: hash router, top bar (Docker status, domain root), the
 * /ws/events connection with reconnect + polling fallback, token prompt
 * wiring and global error toasts.
 * @module app
 */
import { api, onUnauthorized, wsUrl } from './api.js';
import { debounce } from './format.js';
import { clear, el, emit, promptToken, toast } from './ui.js';
import { renderContainersView } from './containers.js';
import { renderDomainsView } from './domains.js';
import { openLaunchDialog } from './launch.js';

const HEALTH_MS = 15_000;
const EVENTS_MAX_BACKOFF_MS = 30_000;

const viewRoot = document.getElementById('view');
const dockerDot = document.getElementById('docker-dot');
const eventsDot = document.getElementById('events-dot');
const domainRootEl = document.getElementById('domain-root');
const navLinks = Array.from(document.querySelectorAll('.nav a[data-route]'));

/** @type {{ name: 'containers'|'domains', param: string|null, view: { destroy(): void }|null }} */
let current = { name: 'containers', param: null, view: null };

/* ---------- router ---------- */

/** @returns {{ name: 'containers'|'domains', param: string|null }} */
function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [name, ...rest] = hash.split('/');
  if (name === 'domains') {
    let param = null;
    if (rest.length) {
      try {
        param = decodeURIComponent(rest.join('/'));
      } catch {
        param = rest.join('/');
      }
    }
    return { name: 'domains', param };
  }
  return { name: 'containers', param: null };
}

function route() {
  const r = parseRoute();
  if (current.view) {
    try {
      current.view.destroy();
    } catch (err) {
      console.error('view teardown failed', err);
    }
  }
  clear(viewRoot);
  current = { ...r, view: null };
  for (const a of navLinks) {
    if (a.dataset.route === r.name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  try {
    current.view = r.name === 'domains' ? renderDomainsView(viewRoot, { name: r.param }) : renderContainersView(viewRoot);
  } catch (err) {
    console.error('view render failed', err);
    viewRoot.appendChild(el('div', { class: 'error-box' }, `The view could not be rendered: ${err.message}`));
  }
}

/* ---------- health / top bar ---------- */

let lastHealthError = null;

function applyHealth(h) {
  const d = h.docker || {};
  if (d.ok) {
    dockerDot.className = 'docker-dot ok';
    dockerDot.title = `Docker ${d.version || ''} (API ${d.apiVersion || '?'}) · ${d.os || ''} ${d.arch || ''} · ${d.containers ?? '?'} containers, ${d.images ?? '?'} images`.replace(/\s+/g, ' ');
    if (lastHealthError) toast(lastHealthError.startsWith('Access token') ? 'Access token accepted' : 'EASY MXL server and Docker daemon reachable', { kind: 'success' });
    lastHealthError = null;
  } else {
    setUnhealthy(`Docker unreachable: ${d.error || 'unknown error'}`);
  }
  domainRootEl.textContent = h.domainRoot || '';
  const fs = h.domainRootFs;
  if (fs && fs.tmpfs === false) {
    domainRootEl.classList.add('warn');
    domainRootEl.title = `Domain root ${h.domainRoot} is not on tmpfs (${fs.fsType || 'unknown fs'}) — MXL flows will hit disk`;
  } else {
    domainRootEl.classList.remove('warn');
    domainRootEl.title = `Domain root${fs && fs.tmpfs ? ' (tmpfs)' : ''}${h.procLocksReadable === false ? ' — /proc/locks not readable, flow activity unknown' : ''}`;
  }
  if (h.version) document.title = `EASY MXL v${h.version}`;
}

function setUnhealthy(message) {
  dockerDot.className = 'docker-dot bad';
  dockerDot.title = message;
  if (message !== lastHealthError) toast(message, { kind: 'error' });
  lastHealthError = message;
}

async function pollHealth() {
  try {
    applyHealth(await api.get('/api/health'));
  } catch (err) {
    if (err && err.status === 401) setUnhealthy('Access token required: reload the page and enter the token when asked');
    else setUnhealthy(`Cannot reach the EASY MXL server: ${err.message}`);
  }
}

/* ---------- live events ---------- */

let backoff = 1000;
/** @type {WebSocket|null} */
let eventsWs = null;
const containersChanged = debounce(() => emit('containers-changed'), 300);

function setEventsState(connected) {
  eventsDot.className = `events-dot${connected ? ' ok' : ''}`;
  eventsDot.title = connected ? 'Live events: connected' : 'Live events: disconnected — polling every 10 s';
}

function connectEvents() {
  let ws;
  try {
    ws = new WebSocket(wsUrl('/ws/events'));
  } catch (err) {
    console.warn('events socket failed', err);
    scheduleReconnect();
    return;
  }
  eventsWs = ws;
  ws.onopen = () => {
    backoff = 1000;
    setEventsState(true);
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'container') {
      emit('container', msg);
      containersChanged();
    } else if (msg.type === 'job') {
      emit('job', msg.job);
    } else if (msg.type === 'image') {
      emit('image', msg);
    }
  };
  ws.onclose = () => {
    if (eventsWs !== ws) return;
    eventsWs = null;
    setEventsState(false);
    scheduleReconnect();
  };
  ws.onerror = () => { /* onclose follows and schedules the reconnect */ };
}

function scheduleReconnect() {
  setTimeout(connectEvents, backoff);
  backoff = Math.min(backoff * 2, EVENTS_MAX_BACKOFF_MS);
}

/* ---------- boot ---------- */

function boot() {
  onUnauthorized(promptToken);
  document.getElementById('btn-launch').addEventListener('click', () => {
    openLaunchDialog({ domain: current.name === 'domains' ? current.param : null });
  });
  window.addEventListener('hashchange', route);
  window.addEventListener('error', (e) => toast(`Unexpected error: ${e.message}`, { kind: 'error' }));
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    toast(`Unexpected error: ${reason && reason.message ? reason.message : String(reason)}`, { kind: 'error' });
  });
  setEventsState(false);
  route();
  pollHealth();
  setInterval(pollHealth, HEALTH_MS);
  connectEvents();
}

boot();
