/**
 * Thin wrapper around fetch/WebSocket for the EASY MXL API (DESIGN.md §7–§8).
 *
 * Adds the access token from localStorage['easy-mxl.token'], converts error
 * responses into ApiError({status, code, message, details}) and, on 401,
 * asks the registered handler for a token and retries once.
 * @module api
 */

const TOKEN_KEY = 'easy-mxl.token';

/** @type {(() => Promise<string|null>) | null} */
let unauthorizedHandler = null;
/** @type {Promise<string|null> | null} */
let pendingPrompt = null;

/** Error thrown for failed API calls. `status` 0 means the server was unreachable. */
export class ApiError extends Error {
  /**
   * @param {number} status HTTP status (0 for network failures)
   * @param {string} code machine-readable code from the server or a client-side code
   * @param {string} message human-readable message
   * @param {any} [details]
   */
  constructor(status, code, message, details) {
    super(message || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** @returns {string} the stored access token or '' */
export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

/** Store (or, with an empty value, forget) the access token. @param {string} token */
export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable (private mode) — token lives for this page only */
  }
}

/**
 * Register the function invoked when the server answers 401. It must resolve
 * with a new token (which is stored) or null when the user cancelled.
 * @param {() => Promise<string|null>} handler
 */
export function onUnauthorized(handler) {
  unauthorizedHandler = handler;
}

/**
 * Build a query string from an object; null/undefined values are skipped.
 * @param {Record<string, any>} [params]
 * @returns {string} '' or '?k=v&…'
 */
export function buildQuery(params) {
  if (!params) return '';
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    usp.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

/** After a cancelled prompt, stop asking again for a while so background pollers do not nag. */
let suppressPromptUntil = 0;
const PROMPT_SUPPRESS_MS = 60_000;

function promptForToken() {
  if (!pendingPrompt) {
    pendingPrompt = Promise.resolve()
      .then(() => (unauthorizedHandler ? unauthorizedHandler() : null))
      .then((token) => {
        if (token) setToken(token);
        else suppressPromptUntil = Date.now() + PROMPT_SUPPRESS_MS;
        return token || null;
      })
      .catch(() => null)
      .finally(() => {
        pendingPrompt = null;
      });
  }
  return pendingPrompt;
}

async function parseJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Perform an API request and return the parsed JSON body.
 * @param {string} method
 * @param {string} path absolute path such as '/api/containers'
 * @param {{ body?: any, query?: Record<string, any>, retry?: boolean }} [opts]
 * @returns {Promise<any>}
 */
export async function request(method, path, { body, query, retry = true } = {}) {
  const headers = { Accept: 'application/json' };
  const token = getToken();
  if (token) headers['X-Easy-MXL-Token'] = token;
  /** @type {RequestInit} */
  const init = { method, headers, cache: 'no-store' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path + buildQuery(query), init);
  } catch (err) {
    throw new ApiError(0, 'network_error', `Cannot reach the EASY MXL server (${err && err.message ? err.message : err})`);
  }
  if (res.status === 401 && retry && unauthorizedHandler && Date.now() >= suppressPromptUntil) {
    const fresh = await promptForToken();
    if (fresh) return request(method, path, { body, query, retry: false });
  }
  const payload = await parseJson(res);
  if (!res.ok) {
    const e = (payload && payload.error) || {};
    throw new ApiError(res.status, e.code || `http_${res.status}`, e.message || `${res.status} ${res.statusText || 'request failed'}`, e.details);
  }
  return payload;
}

/** Convenience verbs. */
export const api = {
  /** @param {string} path @param {Record<string, any>} [query] */
  get: (path, query) => request('GET', path, { query }),
  /** @param {string} path @param {any} [body] */
  post: (path, body) => request('POST', path, { body }),
  /** @param {string} path @param {any} body */
  patch: (path, body) => request('PATCH', path, { body }),
  /** @param {string} path @param {Record<string, any>} [query] */
  del: (path, query) => request('DELETE', path, { query }),
};

/**
 * REST path for a container resource. `id` may be a full id, short id or name.
 * @param {string} id
 * @param {string} [suffix] e.g. '/start'
 */
export function containerPath(id, suffix = '') {
  return `/api/containers/${encodeURIComponent(id)}${suffix}`;
}

/**
 * REST path for a domain resource.
 * @param {string} name
 * @param {string} [suffix] e.g. '/flows'
 */
export function domainPath(name, suffix = '') {
  return `/api/domains/${encodeURIComponent(name)}${suffix}`;
}

/**
 * Build a WebSocket URL for a `/ws/*` endpoint, adding the token as `?token=`.
 * @param {string} path e.g. '/ws/events'
 * @param {Record<string, any>} [query]
 * @returns {string}
 */
export function wsUrl(path, query = {}) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const q = { ...query };
  const token = getToken();
  if (token) q.token = token;
  return `${proto}//${location.host}${path}${buildQuery(q)}`;
}
