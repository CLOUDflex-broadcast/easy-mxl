/**
 * HTTP server: express app (static frontend, vendored xterm files, `/api/*`
 * routers, JSON error handling), token auth and the `/ws/*` upgrade hook.
 */
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import express from 'express';
import { HttpError, toHttpError } from './errors.js';
import { log as defaultLog } from './log.js';
import { indexById } from './catalog.js';
import { createJobRegistry } from './jobs.js';
import { getTaiOffsetNs } from './mxl/time.js';
import { createApiRouter } from './routes/index.js';
import { createContainerCache } from './routes/containers.js';
import { attachWebSockets } from './ws.js';

const JSON_LIMIT = '1mb';
const CONTAINER_CACHE_MS = 2000;
const VENDOR_MAX_AGE_MS = 60 * 60 * 1000;
const FORCE_CLOSE_MS = 3000;

/**
 * @typedef {object} RouteContext shared by every router and the WebSocket handlers
 * @property {import('./config.js').Config} config
 * @property {import('dockerode')} docker
 * @property {object[]} catalog enabled catalog apps
 * @property {Map<string, object>} catalogById
 * @property {ReturnType<typeof createJobRegistry>} jobs
 * @property {typeof defaultLog} log
 * @property {() => Promise<{ offsetNs: number, source: string }>} getTaiOffset
 * @property {() => Promise<object[]>} listContainersCached ContainerSummary[] cached for 2 s
 * @property {(req: http.IncomingMessage) => boolean} authorize
 * @property {(req: http.IncomingMessage) => boolean} originAllowed host + origin check for WebSocket upgrades
 */

/**
 * Token supplied by a request: `Authorization: Bearer`, `X-Easy-MXL-Token` or `?token=`.
 * Works for express requests and raw upgrade requests alike.
 *
 * @param {http.IncomingMessage} req
 * @returns {string|null}
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Hostname part of a `Host`/authority string (`example.com:9700` → `example.com`,
 * `[::1]:9700` → `::1`), lower-cased; '' when absent.
 * @param {unknown} authority
 * @returns {string}
 */
export function hostnameOf(authority) {
  if (typeof authority !== 'string' || !authority) return '';
  const a = authority.trim().toLowerCase();
  if (a.startsWith('[')) {
    const end = a.indexOf(']');
    return end === -1 ? a : a.slice(1, end);
  }
  const colon = a.lastIndexOf(':');
  return colon === -1 ? a : a.slice(0, colon);
}

/**
 * Is `config.host` a loopback bind address?
 * @param {string} host
 * @returns {boolean}
 */
function isLoopbackBind(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return LOOPBACK_NAMES.has(h) || h.startsWith('127.');
}

/**
 * Does an entry of `config.allowedOrigins` (an origin, a host or a hostname) match?
 * @param {string[]|undefined} allowed
 * @param {string} origin full origin (may be '')
 * @param {string} host `host[:port]`
 * @returns {boolean}
 */
function inAllowList(allowed, origin, host) {
  const hostname = hostnameOf(host);
  for (const raw of Array.isArray(allowed) ? allowed : []) {
    const entry = String(raw).trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    if (origin && entry === origin.toLowerCase()) return true;
    if (entry === host.toLowerCase() || entry === hostname) return true;
    if (entry.includes('://') && hostnameOf(entry.replace(/^[a-z]+:\/\//, '')) === hostname) return true;
  }
  return false;
}

/**
 * Browser origin check for state-changing API calls and WebSocket upgrades. Browsers do not
 * apply the same-origin policy to WebSocket handshakes or to "simple" POSTs, so a page on any
 * site could otherwise drive Docker through a logged-in operator's browser. A request is
 * allowed when it has no `Origin` (non-browser client) and is not flagged `cross-site` by
 * fetch metadata, when its `Origin` host equals the request `Host`, or when it matches
 * `config.allowedOrigins`.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{ allowedOrigins?: string[] }} config
 * @returns {boolean}
 */
export function originAllowed(req, config) {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
  const host = String(req.headers.host || '').trim().toLowerCase();
  if (!origin) {
    return req.headers['sec-fetch-site'] !== 'cross-site';
  }
  if (origin === 'null') return inAllowList(config.allowedOrigins, 'null', '');
  let originHost;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  if (originHost && originHost === host) return true;
  return inAllowList(config.allowedOrigins, origin, originHost);
}

/**
 * DNS-rebinding guard: when EASY MXL is bound to loopback, the `Host` header must name the
 * loopback interface (or an entry of `config.allowedOrigins`). Always true for other binds.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{ host: string, allowedOrigins?: string[] }} config
 * @returns {boolean}
 */
export function hostAllowed(req, config) {
  if (!isLoopbackBind(config.host)) return true;
  const host = String(req.headers.host || '').trim();
  const hostname = hostnameOf(host);
  if (!hostname) return true;
  if (LOOPBACK_NAMES.has(hostname) || hostname.startsWith('127.')) return true;
  return inAllowList(config.allowedOrigins, '', host);
}

/**
 * Hide the access token when a request URL is written to the log.
 * @param {unknown} url
 * @returns {string}
 */
export function redactUrl(url) {
  return String(url ?? '').replace(/([?&]token=)[^&#]*/gi, '$1REDACTED');
}

export function extractToken(req) {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  const header = req.headers['x-easy-mxl-token'];
  const headerValue = Array.isArray(header) ? header[0] : header;
  if (typeof headerValue === 'string' && headerValue.trim()) return headerValue.trim();
  const url = typeof req.url === 'string' ? req.url : '';
  const q = url.indexOf('?');
  if (q >= 0) {
    const token = new URLSearchParams(url.slice(q + 1)).get('token');
    if (token) return token;
  }
  return null;
}

/**
 * Constant-time comparison of the request token against the configured one.
 * A `null`/empty configured token disables authentication.
 *
 * @param {http.IncomingMessage} req
 * @param {string|null|undefined} token
 * @returns {boolean}
 */
export function isAuthorized(req, token) {
  if (!token) return true;
  const supplied = extractToken(req);
  if (!supplied) return false;
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(token, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Map body-parser failures (which carry a generic `statusCode`) to specific codes.
 * @param {unknown} err
 * @returns {HttpError|null} `null` when `err` is not a body-parser error
 */
function bodyParserError(err) {
  const type = err && typeof err === 'object' ? /** @type {any} */ (err).type : undefined;
  switch (type) {
    case 'entity.parse.failed':
      return new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
    case 'entity.too.large':
      return new HttpError(413, 'payload_too_large', `Request body exceeds ${JSON_LIMIT}`);
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return new HttpError(415, 'unsupported_media_type', 'Request body must be UTF-8 JSON');
    default:
      return null;
  }
}

/**
 * Locate the xterm.js assets inside node_modules. Missing packages yield an
 * empty map (the terminal panel then reports the problem instead of crashing).
 * @param {typeof defaultLog} log
 * @returns {Map<string, string>} file name → absolute path
 */
function resolveVendorFiles(log) {
  const require = createRequire(import.meta.url);
  const files = new Map();
  try {
    const xterm = require.resolve('@xterm/xterm');
    files.set('xterm.js', xterm);
    files.set('xterm.css', path.resolve(path.dirname(xterm), '..', 'css', 'xterm.css'));
  } catch (err) {
    log.warn('@xterm/xterm is not installed; the terminal panel will not work', { error: err && err.message });
  }
  try {
    files.set('addon-fit.js', require.resolve('@xterm/addon-fit'));
  } catch (err) {
    log.warn('@xterm/addon-fit is not installed; the terminal panel will not work', { error: err && err.message });
  }
  return files;
}

/**
 * Build the TAI offset provider: a fixed number, a custom function, or the
 * python3-backed estimate from `src/mxl/time.js`.
 * @param {unknown} taiOffset `deps.taiOffset`
 * @param {typeof defaultLog} log
 * @returns {RouteContext['getTaiOffset']}
 */
function makeTaiOffsetProvider(taiOffset, log) {
  if (typeof taiOffset === 'number' && Number.isFinite(taiOffset)) {
    return async () => ({ offsetNs: taiOffset, source: 'fixed' });
  }
  if (typeof taiOffset === 'function') {
    return async () => {
      const value = await taiOffset();
      if (typeof value === 'number') return { offsetNs: value, source: 'custom' };
      const v = value && typeof value === 'object' ? value : {};
      return { offsetNs: Number.isFinite(Number(v.offsetNs)) ? Number(v.offsetNs) : 0, source: typeof v.source === 'string' ? v.source : 'custom' };
    };
  }
  return async () => {
    try {
      const offsetNs = await getTaiOffsetNs();
      return { offsetNs, source: getTaiOffsetNs.source };
    } catch (err) {
      log.debug('TAI offset unavailable, assuming 0', { error: err && err.message });
      return { offsetNs: 0, source: 'assumed-zero' };
    }
  };
}

/**
 * Create the EASY MXL HTTP/WebSocket server (not yet listening).
 *
 * @param {import('./config.js').Config} config
 * @param {{ docker: import('dockerode'), catalog?: object[], jobs?: ReturnType<typeof createJobRegistry>, log?: typeof defaultLog, taiOffset?: number|(() => any) }} deps
 * @returns {{ app: import('express').Express, httpServer: http.Server, wss: import('ws').WebSocketServer, start(): Promise<{ port: number, host: string }>, stop(): Promise<void> }}
 */
export function createServer(config, deps = {}) {
  if (!config || typeof config !== 'object' || typeof config.publicDir !== 'string') {
    throw new TypeError('createServer: config with publicDir is required (use loadConfig)');
  }
  if (!deps || !deps.docker) {
    throw new TypeError('createServer: deps.docker (a Dockerode instance or compatible fake) is required');
  }
  const log = deps.log || defaultLog;
  const catalog = Array.isArray(deps.catalog) ? deps.catalog : [];
  const catalogById = indexById(catalog);
  /** @type {RouteContext} */
  const ctx = {
    config,
    docker: deps.docker,
    catalog,
    catalogById,
    jobs: deps.jobs || createJobRegistry(),
    log,
    getTaiOffset: makeTaiOffsetProvider(deps.taiOffset, log),
    listContainersCached: createContainerCache(deps.docker, { domainRoot: config.domainRoot, catalogById }, CONTAINER_CACHE_MS),
    authorize: (req) => isAuthorized(req, config.token),
    originAllowed: (req) => hostAllowed(req, config) && originAllowed(req, config),
  };

  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      log.debug(`${req.method} ${redactUrl(req.originalUrl)} -> ${res.statusCode} (${ms.toFixed(1)} ms)`);
    });
    next();
  });

  app.use(
    '/api',
    (req, res, next) => {
      res.set('Cache-Control', 'no-store');
      next();
    },
    (req, res, next) => {
      if (!hostAllowed(req, config)) {
        next(new HttpError(403, 'host_not_allowed', `Requests addressed to host "${req.headers.host}" are not accepted while EASY MXL is bound to loopback; use localhost or add the name with --allowed-origins`));
        return;
      }
      if (!SAFE_METHODS.has(req.method) && !originAllowed(req, config)) {
        next(new HttpError(403, 'origin_not_allowed', 'Cross-origin requests are not allowed (add trusted origins with --allowed-origins)'));
        return;
      }
      next();
    },
    (req, res, next) => {
      if (ctx.authorize(req)) return next();
      next(new HttpError(401, 'unauthorized', 'Missing or invalid token (use Authorization: Bearer, X-Easy-MXL-Token or ?token=)'));
    },
    express.json({ limit: JSON_LIMIT }),
    createApiRouter(ctx),
  );

  const vendor = resolveVendorFiles(log);
  app.get('/vendor/:file', (req, res, next) => {
    const file = vendor.get(req.params.file);
    if (!file) {
      next(new HttpError(404, 'not_found', `Unknown vendor file "${req.params.file}"`));
      return;
    }
    res.sendFile(file, { maxAge: VENDOR_MAX_AGE_MS }, (err) => {
      if (err) next(err);
    });
  });

  app.use(express.static(config.publicDir, { index: 'index.html' }));

  app.use((req, res, next) => {
    next(new HttpError(404, 'not_found', `Not found: ${req.method} ${redactUrl(req.originalUrl)}`));
  });

  // eslint-disable-next-line no-unused-vars -- express identifies error handlers by arity
  app.use((err, req, res, next) => {
    const httpErr = bodyParserError(err) || toHttpError(err);
    log.debug('request failed', {
      method: req.method,
      url: redactUrl(req.originalUrl),
      status: httpErr.status,
      code: httpErr.code,
      stack: err && err.stack ? String(err.stack) : String(err),
    });
    if (httpErr.status >= 500) {
      log.warn(`${req.method} ${redactUrl(req.originalUrl)} -> ${httpErr.status} ${httpErr.code}: ${httpErr.message}`);
    }
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(httpErr.status).json(httpErr.toJSON());
  });

  const httpServer = http.createServer(app);
  const sockets = attachWebSockets(httpServer, ctx);

  return {
    app,
    httpServer,
    wss: sockets.wss,

    /**
     * Bind to `config.host:config.port`.
     * @returns {Promise<{ port: number, host: string }>} rejects with the `listen` error (e.g. `EADDRINUSE`)
     */
    start() {
      return new Promise((resolve, reject) => {
        const onError = (err) => {
          httpServer.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          httpServer.off('error', onError);
          const address = httpServer.address();
          resolve(typeof address === 'object' && address ? { port: address.port, host: address.address } : { port: config.port, host: config.host });
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(config.port, config.host);
      });
    },

    /**
     * Close WebSocket clients, the Docker event stream and the HTTP server.
     * @returns {Promise<void>}
     */
    async stop() {
      await sockets.close();
      await new Promise((resolve) => {
        const timer = setTimeout(() => httpServer.closeAllConnections(), FORCE_CLOSE_MS);
        timer.unref();
        httpServer.close(() => {
          clearTimeout(timer);
          resolve();
        });
        httpServer.closeIdleConnections();
      });
    },
  };
}
