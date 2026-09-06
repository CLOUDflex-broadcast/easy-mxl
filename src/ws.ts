/**
 * WebSocket endpoints (DESIGN.md §8) on a single `WebSocketServer` in
 * `noServer` mode: `/ws/events`, `/ws/containers/:id/logs` and
 * `/ws/containers/:id/terminal`. Auth is enforced on the upgrade request,
 * unknown paths get an HTTP 404 and dead sockets are reaped by a 30 s ping.
 */
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { toHttpError } from './errors.js';
import { watchEvents } from './docker/events.js';
import { streamLogs } from './docker/logs.js';
import { openTerminal } from './docker/terminal.js';

const HEARTBEAT_MS = 30000;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_QUEUED_INPUT = 64;
const DEFAULT_LOG_TAIL = 200;
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const LOGS_RE = /^\/ws\/containers\/([^/]+)\/logs$/;
const TERMINAL_RE = /^\/ws\/containers\/([^/]+)\/terminal$/;

/** WebSocket close codes used below. */
const CLOSE_NORMAL = 1000;
const CLOSE_ERROR = 1011;

const noop = () => {};

/**
 * @param {string} pathname
 * @returns {{ kind: 'events'|'logs'|'terminal', id?: string }|null}
 */
function matchRoute(pathname) {
  if (pathname === '/ws/events') return { kind: 'events' };
  let m = LOGS_RE.exec(pathname);
  if (m) return { kind: 'logs', id: safeDecode(m[1]) };
  m = TERMINAL_RE.exec(pathname);
  if (m) return { kind: 'terminal', id: safeDecode(m[1]) };
  return null;
}

/** @param {string} s */
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Answer an upgrade request with a plain HTTP error and close the socket.
 * @param {import('node:stream').Duplex} socket
 * @param {number} status
 * @param {string} code
 * @param {string} message
 */
function rejectUpgrade(socket, status, code, message) {
  const body = JSON.stringify({ error: { code, message } });
  const head = [
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] || 'Error'}`,
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n');
  socket.once('finish', () => socket.destroy());
  socket.end(head + body);
}

/**
 * @param {import('ws').RawData} data
 * @returns {object|null}
 */
function parseControl(data) {
  try {
    const msg = JSON.parse(data.toString());
    return msg && typeof msg === 'object' ? msg : null;
  } catch {
    return null;
  }
}

/**
 * Attach the WebSocket endpoints to an HTTP server.
 *
 * @param {http.Server} httpServer
 * @param {import('./server.js').RouteContext} ctx
 * @param {{ heartbeatMs?: number }} [opts]
 * @returns {{ wss: WebSocketServer, close(): Promise<void> }}
 */
export function attachWebSockets(httpServer, ctx, { heartbeatMs = HEARTBEAT_MS } = {}) {
  const { log, jobs, docker, config } = ctx;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  wss.on('error', (err) => log.warn('websocket server error', { error: err && err.message }));

  /** @type {Set<WebSocket>} */
  const eventClients = new Set();
  /** @type {Promise<{ stop(): void }|null>|null} */
  let watcher = null;
  let closed = false;

  const send = (ws, frame) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame), noop);
  };
  const broadcast = (frame) => {
    const text = JSON.stringify(frame);
    for (const ws of eventClients) send(ws, text);
  };

  const onJob = (job) => broadcast({ type: 'job', job });
  jobs.on('update', onJob);

  /** Start the Docker event stream once, on the first subscriber. */
  function ensureWatcher() {
    if (watcher || closed) return;
    watcher = watchEvents(docker, (ev) => {
      if (ev.type === 'container') {
        broadcast({ type: 'container', action: ev.action, id: ev.id, name: ev.name, image: ev.image, time: ev.time });
      } else if (ev.type === 'image') {
        broadcast({ type: 'image', action: ev.action, id: ev.id, time: ev.time });
      }
    }, { types: ['container', 'image'] }).catch((err) => {
      log.warn('docker event stream could not be started', { error: err && err.message });
      watcher = null;
      return null;
    });
  }

  /** @param {WebSocket} ws */
  function handleEvents(ws) {
    eventClients.add(ws);
    ws.on('close', () => eventClients.delete(ws));
    send(ws, { type: 'hello', version: config.version });
    ensureWatcher();
  }

  /**
   * @param {WebSocket} ws
   * @param {string} id
   * @param {URLSearchParams} params
   */
  async function handleLogs(ws, id, params) {
    let handle = null;
    let finished = false;
    const finish = (frame, code) => {
      if (finished) return;
      finished = true;
      send(ws, frame);
      ws.close(code);
    };
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = parseControl(data);
      if (msg && msg.type === 'stop') {
        if (handle) handle.stop();
        else finish({ type: 'end' }, CLOSE_NORMAL);
      }
    });
    ws.on('close', () => {
      finished = true;
      if (handle) handle.stop();
    });

    const tail = params.get('tail');
    const timestamps = TRUTHY.has(String(params.get('timestamps') || '').toLowerCase());
    try {
      const h = await streamLogs(docker, id, { tail: tail === null || tail === '' ? DEFAULT_LOG_TAIL : tail, timestamps, follow: true }, {
        onChunk: (stream, text) => send(ws, { type: 'log', stream, text }),
        onEnd: () => finish({ type: 'end' }, CLOSE_NORMAL),
        onError: (err) => finish({ type: 'error', message: err.message }, CLOSE_ERROR),
      });
      if (finished || ws.readyState !== WebSocket.OPEN) {
        h.stop();
        return;
      }
      handle = h;
    } catch (err) {
      const e = toHttpError(err);
      log.debug('log stream failed to open', { id, code: e.code, message: e.message });
      finish({ type: 'error', message: e.message }, CLOSE_ERROR);
    }
  }

  /**
   * @param {WebSocket} ws
   * @param {string} id
   * @param {URLSearchParams} params
   */
  async function handleTerminal(ws, id, params) {
    let term = null;
    let finished = false;
    /** @type {{ data: import('ws').RawData, isBinary: boolean }[]} */
    const queued = [];
    const finish = (frame, code) => {
      if (finished) return;
      finished = true;
      send(ws, frame);
      ws.close(code);
    };
    const deliver = (data, isBinary) => {
      if (isBinary) {
        term.write(Buffer.isBuffer(data) ? data : Buffer.from(/** @type {any} */ (data)));
        return;
      }
      const msg = parseControl(data);
      if (msg && msg.type === 'resize') {
        term.resize(msg.cols, msg.rows).catch((err) => log.debug('terminal resize failed', { id, error: err && err.message }));
      }
    };
    ws.on('message', (data, isBinary) => {
      if (term) {
        deliver(data, isBinary);
      } else if (queued.length < MAX_QUEUED_INPUT) {
        queued.push({ data, isBinary });
      }
    });
    ws.on('close', () => {
      finished = true;
      if (term) term.close();
    });

    try {
      const t = await openTerminal(docker, id, {
        cmd: params.get('cmd') || undefined,
        cols: params.get('cols') || undefined,
        rows: params.get('rows') || undefined,
      });
      if (finished || ws.readyState !== WebSocket.OPEN) {
        t.close();
        return;
      }
      term = t;
      t.stream.on('data', (chunk) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true }, noop);
      });
      t.stream.on('error', (err) => log.debug('terminal stream error', { id, error: err && err.message }));
      t.onExit((code) => finish({ type: 'exit', code }, CLOSE_NORMAL));
      send(ws, { type: 'ready' });
      for (const { data, isBinary } of queued.splice(0)) deliver(data, isBinary);
    } catch (err) {
      const e = toHttpError(err);
      log.debug('terminal failed to open', { id, code: e.code, message: e.message });
      finish({ type: 'error', message: e.message }, CLOSE_ERROR);
    }
  }

  httpServer.on('upgrade', (req, socket, head) => {
    socket.on('error', (err) => log.debug('upgrade socket error', { error: err && err.message }));
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      rejectUpgrade(socket, 400, 'bad_request', 'Malformed upgrade URL');
      return;
    }
    const route = matchRoute(url.pathname);
    if (!route) {
      rejectUpgrade(socket, 404, 'not_found', `No WebSocket endpoint at ${url.pathname}`);
      return;
    }
    if (!ctx.authorize(req)) {
      rejectUpgrade(socket, 401, 'unauthorized', 'Missing or invalid token');
      return;
    }
    // Browsers do not apply the same-origin policy to WebSocket handshakes, so a page on any
    // site could otherwise open a terminal into a container. Require a matching Origin.
    if (typeof ctx.originAllowed === 'function' && !ctx.originAllowed(req)) {
      rejectUpgrade(socket, 403, 'origin_not_allowed', 'Cross-origin WebSocket connections are not allowed');
      return;
    }
    if (closed) {
      rejectUpgrade(socket, 503, 'shutting_down', 'Server is shutting down');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
      });
      ws.on('error', (err) => log.debug('websocket error', { path: url.pathname, error: err && err.message }));
      if (route.kind === 'events') handleEvents(ws);
      else if (route.kind === 'logs') handleLogs(ws, route.id, url.searchParams);
      else handleTerminal(ws, route.id, url.searchParams);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping(noop);
    }
  }, heartbeatMs);
  heartbeat.unref();

  return {
    wss,
    /**
     * Stop the heartbeat and event stream, drop every client.
     * @returns {Promise<void>}
     */
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      jobs.off('update', onJob);
      if (watcher) {
        const w = await watcher;
        if (w) w.stop();
      }
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}
