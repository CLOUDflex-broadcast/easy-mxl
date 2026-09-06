/**
 * Container log slide-over: streams /ws/containers/:id/logs, keeps at most
 * MAX_LINES lines in the DOM, autoscrolls unless the user scrolled up, strips
 * ANSI SGR sequences and reconnects when the container restarts.
 * @module logs
 */
import { wsUrl } from './api.js';
import { stripAnsi } from './format.js';
import { bus, el, icon, openPanel } from './ui.js';

const MAX_LINES = 5000;
const TAIL_OPTIONS = [100, 500, 2000];

/**
 * Open the logs panel for a container.
 * @param {{ id: string, name: string }} container full id (or name) and display name
 * @returns {{ close: () => void }}
 */
export function openLogsPanel({ id, name }) {
  let ws = null;
  let tail = 500;
  let timestamps = false;
  let autoscroll = true;
  let lineCount = 0;
  let raf = 0;
  /** @type {Array<{stream: string, text: string, sys?: boolean}>} */
  let pending = [];
  const partial = { stdout: '', stderr: '' };
  let ended = false;

  const pre = el('div', { class: 'log-pre wrap', role: 'log', 'aria-live': 'off', tabindex: 0 });
  const jump = el('button', { class: 'btn sm jump-chip hidden', type: 'button', onClick: () => { autoscroll = true; scrollToBottom(); } }, icon('down'), 'Jump to bottom');
  const status = el('div', { class: 'status-line', text: 'connecting…' });

  const tailSel = el('select', { 'aria-label': 'Tail lines', onChange: () => { tail = Number(tailSel.value); reconnect(); } },
    TAIL_OPTIONS.map((n) => el('option', { value: String(n), selected: n === tail }, `tail ${n}`)));
  const tsBox = el('input', { type: 'checkbox', onChange: () => { timestamps = tsBox.checked; reconnect(); } });
  const wrapBox = el('input', { type: 'checkbox', checked: true, onChange: () => pre.classList.toggle('wrap', wrapBox.checked) });
  const tools = el('div', { class: 'panel-tools' },
    tailSel,
    el('label', null, tsBox, 'timestamps'),
    el('label', null, wrapBox, 'wrap'),
    el('span', { class: 'spacer' }),
    el('button', { class: 'btn sm', type: 'button', onClick: clearLines }, 'Clear'),
    el('button', { class: 'btn sm', type: 'button', onClick: reconnect }, 'Reconnect'));

  const panel = openPanel({ title: 'Logs', subtitle: name, className: 'logs-panel', onClose: destroy });
  panel.body.append(tools, pre, jump, status);

  pre.addEventListener('scroll', () => {
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 12;
    autoscroll = atBottom;
    jump.classList.toggle('hidden', atBottom);
  });

  function scrollToBottom() {
    pre.scrollTop = pre.scrollHeight;
    jump.classList.add('hidden');
  }

  function clearLines() {
    pre.replaceChildren();
    lineCount = 0;
    pending = [];
  }

  function setStatus(text) {
    status.textContent = text;
  }

  function pushLine(stream, text, sys = false) {
    pending.push({ stream, text, sys });
    if (!raf) raf = requestAnimationFrame(flush);
  }

  function flush() {
    raf = 0;
    if (pending.length === 0) return;
    const frag = document.createDocumentFragment();
    const batch = pending.length > MAX_LINES ? pending.slice(-MAX_LINES) : pending;
    pending = [];
    for (const line of batch) {
      frag.appendChild(el('span', { class: `log-line${line.stream === 'stderr' ? ' stderr' : ''}${line.sys ? ' sys' : ''}`, text: line.text }));
    }
    pre.appendChild(frag);
    lineCount += batch.length;
    while (lineCount > MAX_LINES && pre.firstChild) {
      pre.firstChild.remove();
      lineCount -= 1;
    }
    if (autoscroll) scrollToBottom();
  }

  /** Split a chunk into whole lines, keeping the trailing partial line per stream. */
  function onChunk(stream, text) {
    const key = stream === 'stderr' ? 'stderr' : 'stdout';
    const data = partial[key] + stripAnsi(text).replace(/\r(?!\n)/g, '');
    const parts = data.split('\n');
    partial[key] = parts.pop() || '';
    for (const p of parts) pushLine(key, p);
  }

  function flushPartials() {
    for (const key of ['stdout', 'stderr']) {
      if (partial[key]) {
        pushLine(key, partial[key]);
        partial[key] = '';
      }
    }
  }

  function connect() {
    ended = false;
    setStatus('connecting…');
    let socket;
    try {
      socket = new WebSocket(wsUrl(`/ws/containers/${encodeURIComponent(id)}/logs`, { tail, timestamps: timestamps ? 1 : 0 }));
    } catch (err) {
      setStatus(`cannot open log stream: ${err.message}`);
      return;
    }
    ws = socket;
    socket.onopen = () => setStatus(`streaming · tail ${tail}${timestamps ? ' · timestamps' : ''}`);
    socket.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'log') onChunk(msg.stream, String(msg.text ?? ''));
      else if (msg.type === 'end') {
        ended = true;
        flushPartials();
        pushLine('stdout', '[stream ended — container stopped or log closed]', true);
        setStatus('stream ended');
      } else if (msg.type === 'error') {
        flushPartials();
        pushLine('stderr', `[error: ${msg.message || 'unknown'}]`, true);
        setStatus(`error: ${msg.message || 'unknown'}`);
      }
    };
    socket.onclose = (ev) => {
      if (ws !== socket) return;
      ws = null;
      flushPartials();
      if (!ended) setStatus(ev.code === 1000 ? 'disconnected' : `disconnected (code ${ev.code})`);
    };
    socket.onerror = () => setStatus('connection error');
  }

  function disconnect() {
    if (!ws) return;
    const socket = ws;
    ws = null;
    try {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop' }));
      socket.close();
    } catch {
      /* already closed */
    }
  }

  function reconnect() {
    disconnect();
    clearLines();
    partial.stdout = '';
    partial.stderr = '';
    connect();
  }

  /** Reconnect automatically once the container comes back after a restart. */
  function onContainerEvent(ev) {
    const d = ev.detail || {};
    const matches = d.id === id || d.name === name || (typeof d.id === 'string' && typeof id === 'string' && d.id.startsWith(id));
    if (!matches) return;
    if ((d.action === 'start' || d.action === 'restart') && !ws) {
      pushLine('stdout', `[container ${d.action}ed — reconnecting]`, true);
      setTimeout(() => { if (!ws && document.contains(pre)) connect(); }, 500);
    }
  }
  bus.addEventListener('container', onContainerEvent);

  function destroy() {
    bus.removeEventListener('container', onContainerEvent);
    if (raf) cancelAnimationFrame(raf);
    disconnect();
  }

  connect();
  return { close: panel.close };
}
