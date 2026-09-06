/**
 * Interactive terminal slide-over built on xterm.js (window.Terminal and
 * window.FitAddon.FitAddon are loaded from /vendor by classic script tags).
 * Binary WebSocket frames carry the byte streams; text frames carry control
 * messages (ready/exit/error from the server, resize from the client).
 * @module terminal
 */
import { wsUrl } from './api.js';
import { debounce } from './format.js';
import { el, openPanel } from './ui.js';

const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
const THEME = {
  background: '#0b0e12', foreground: '#d8dfe7', cursor: '#d8dfe7', cursorAccent: '#0b0e12',
  selectionBackground: 'rgba(61, 165, 255, 0.35)', black: '#1f2732', brightBlack: '#5f6c79',
};

/**
 * Open a terminal panel attached to a running container.
 * @param {{ id: string, name: string, cmd?: string }} container `cmd` optionally replaces the default shell
 * @returns {{ close: () => void }}
 */
export function openTerminalPanel({ id, name, cmd }) {
  const TerminalCtor = window.Terminal;
  const FitCtor = window.FitAddon && window.FitAddon.FitAddon;
  const host = el('div', { class: 'term-host' });
  const status = el('div', { class: 'status-line', text: 'connecting…' });
  const reconnectBtn = el('button', { class: 'btn sm', type: 'button', onClick: () => reconnect() }, 'Reconnect');
  const panel = openPanel({ title: 'Terminal', subtitle: name, className: 'terminal-panel', onClose: destroy });
  panel.head.insertBefore(reconnectBtn, panel.head.lastElementChild);
  panel.body.append(host, status);

  if (typeof TerminalCtor !== 'function' || typeof FitCtor !== 'function') {
    host.appendChild(el('div', { class: 'error-box' }, 'xterm.js is not available: the server did not serve /vendor/xterm.js or /vendor/addon-fit.js.'));
    status.textContent = 'terminal unavailable';
    return { close: panel.close };
  }

  const term = new TerminalCtor({ cursorBlink: true, fontFamily: FONT, fontSize: 13, theme: THEME, scrollback: 5000, allowProposedApi: false });
  const fit = new FitCtor();
  term.loadAddon(fit);
  term.open(host);

  const encoder = new TextEncoder();
  /** @type {WebSocket|null} */
  let ws = null;
  let exited = false;

  function setStatus(text) {
    status.textContent = text;
  }

  function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
  }

  function sendResize() {
    send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }

  function doFit() {
    try {
      fit.fit();
    } catch {
      /* host not measurable yet (panel still animating) */
    }
  }

  const onWindowResize = debounce(() => {
    doFit();
    sendResize();
  }, 150);
  window.addEventListener('resize', onWindowResize);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => onWindowResize()) : null;
  if (observer) observer.observe(host);

  term.onData((data) => send(encoder.encode(data)));
  term.onBinary((data) => {
    const bytes = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i += 1) bytes[i] = data.charCodeAt(i) & 0xff;
    send(bytes);
  });
  term.onResize(() => sendResize());

  function connect() {
    exited = false;
    doFit();
    setStatus('connecting…');
    const query = { cols: term.cols, rows: term.rows };
    if (cmd) query.cmd = cmd;
    let socket;
    try {
      socket = new WebSocket(wsUrl(`/ws/containers/${encodeURIComponent(id)}/terminal`, query));
    } catch (err) {
      setStatus(`cannot open terminal: ${err.message}`);
      return;
    }
    socket.binaryType = 'arraybuffer';
    ws = socket;
    socket.onopen = () => {
      setStatus(`connected · ${term.cols}×${term.rows}`);
      sendResize();
      term.focus();
    };
    socket.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(ev.data));
        return;
      }
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        term.write(String(ev.data));
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ready') { if (!exited) setStatus(`connected · ${term.cols}×${term.rows}`); }
      else if (msg.type === 'exit') {
        exited = true;
        term.write(`\r\n\x1b[90m[process exited with code ${msg.code ?? '?'}]\x1b[0m\r\n`);
        setStatus(`exited with code ${msg.code ?? '?'} — press Reconnect for a new shell`);
      } else if (msg.type === 'error') {
        term.write(`\r\n\x1b[31m[error: ${msg.message || 'unknown'}]\x1b[0m\r\n`);
        setStatus(`error: ${msg.message || 'unknown'}`);
      }
    };
    socket.onclose = (ev) => {
      if (ws !== socket) return;
      ws = null;
      if (!exited) {
        term.write(`\r\n\x1b[90m[connection closed${ev.code && ev.code !== 1000 ? ` (code ${ev.code})` : ''}]\x1b[0m\r\n`);
        setStatus('disconnected — press Reconnect');
      }
    };
    socket.onerror = () => setStatus('connection error');
  }

  function disconnect() {
    if (!ws) return;
    const socket = ws;
    ws = null;
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }

  function reconnect() {
    disconnect();
    term.reset();
    connect();
  }

  function destroy() {
    onWindowResize.cancel();
    window.removeEventListener('resize', onWindowResize);
    if (observer) observer.disconnect();
    disconnect();
    term.dispose();
  }

  // Wait one frame so the panel has its final size before measuring.
  requestAnimationFrame(() => connect());
  return { close: panel.close };
}
