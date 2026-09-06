/**
 * Pure formatting helpers shared by the views. No DOM access, so this module
 * can also be imported from Node tests.
 * @module format
 */

/** Client-side copy of DOMAIN_NAME_RE from src/mxl/domain.js. */
export const DOMAIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Container name rule from DESIGN.md §5.4. */
export const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;
/** ANSI SGR (colour) escape sequences. */
export const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;

/**
 * Shorten a Docker/UUID identifier for display.
 * @param {string|null|undefined} id
 * @param {number} [length=12]
 */
export function shortId(id, length = 12) {
  return id ? String(id).slice(0, length) : '';
}

/**
 * Human-readable byte size (binary units).
 * @param {number|null|undefined} n
 */
export function formatBytes(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  let v = Number(n);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/**
 * Compact age/duration: "0.8 s", "12 s", "3.2 min", "2.1 h", "5 d". Negative
 * values (clock skew) are rendered with a leading minus sign.
 * @param {number|null|undefined} ms
 */
export function formatAge(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '—';
  const v = Number(ms);
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a < 1000) return `${sign}${(a / 1000).toFixed(a < 100 ? 2 : 1)} s`;
  if (a < 60_000) return `${sign}${(a / 1000).toFixed(a < 10_000 ? 1 : 0)} s`;
  if (a < 3_600_000) return `${sign}${(a / 60_000).toFixed(1)} min`;
  if (a < 86_400_000) return `${sign}${(a / 3_600_000).toFixed(1)} h`;
  return `${sign}${(a / 86_400_000).toFixed(1)} d`;
}

/**
 * Relative time from an ISO date to now ("3 min ago"); '' when unknown.
 * @param {string|null|undefined} iso
 * @param {number} [now=Date.now()]
 */
export function formatSince(iso, now = Date.now()) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return `${formatAge(now - t)} ago`;
}

/**
 * Local date-time string for an ISO timestamp; '—' when missing/invalid.
 * @param {string|null|undefined} iso
 */
export function formatDateTime(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : String(iso);
}

/** @param {{numerator:number, denominator?:number}|null|undefined} rate */
export function formatRate(rate) {
  if (!rate || rate.numerator === undefined || rate.numerator === null) return '—';
  const den = rate.denominator === undefined || rate.denominator === null ? 1 : rate.denominator;
  return den === 1 ? String(rate.numerator) : `${rate.numerator}/${den}`;
}

/**
 * Render published ports as "host→container/proto" strings, collapsing
 * consecutive ranges (8200-8210→8200-8210/udp). Unpublished ports render as
 * "container/proto".
 * @param {Array<{ip?:string, hostPort:number|null, containerPort:number, protocol:string}>} ports
 * @returns {string[]}
 */
export function formatPorts(ports) {
  if (!Array.isArray(ports) || ports.length === 0) return [];
  const sorted = ports
    .filter((p) => p && Number.isFinite(Number(p.containerPort)))
    .map((p) => ({ ip: p.ip || '', hostPort: p.hostPort === null || p.hostPort === undefined ? null : Number(p.hostPort), containerPort: Number(p.containerPort), protocol: p.protocol || 'tcp' }))
    .sort((a, b) => a.protocol.localeCompare(b.protocol) || a.ip.localeCompare(b.ip) || a.containerPort - b.containerPort || (a.hostPort ?? -1) - (b.hostPort ?? -1));
  const groups = [];
  for (const p of sorted) {
    const g = groups[groups.length - 1];
    const contiguous = g && g.protocol === p.protocol && g.ip === p.ip && p.containerPort === g.containerEnd + 1
      && ((g.hostEnd === null && p.hostPort === null) || (g.hostEnd !== null && p.hostPort === g.hostEnd + 1));
    if (contiguous) {
      g.containerEnd = p.containerPort;
      g.hostEnd = p.hostPort;
    } else {
      groups.push({ ...p, containerEnd: p.containerPort, hostEnd: p.hostPort });
    }
  }
  const range = (a, b) => (a === b ? String(a) : `${a}-${b}`);
  return groups.map((g) => {
    const container = `${range(g.containerPort, g.containerEnd)}/${g.protocol}`;
    if (g.hostPort === null) return container;
    const ipPrefix = g.ip && g.ip !== '0.0.0.0' && g.ip !== '::' ? `${g.ip}:` : '';
    return `${ipPrefix}${range(g.hostPort, g.hostEnd)}→${container}`;
  });
}

/**
 * Badge class for a Docker container state.
 * @param {string|null|undefined} state
 * @returns {'ok'|'warn'|'bad'|'muted'}
 */
export function stateKind(state) {
  switch (state) {
    case 'running': return 'ok';
    case 'restarting': case 'paused': return 'warn';
    case 'dead': case 'removing': return 'bad';
    default: return 'muted';
  }
}

/**
 * Badge class for a flow status.
 * @param {string|null|undefined} status
 * @returns {'ok'|'warn'|'muted'}
 */
export function flowStatusKind(status) {
  if (status === 'active') return 'ok';
  if (status === 'inactive') return 'warn';
  return 'muted';
}

/** Remove ANSI SGR sequences from a log line. @param {string} text */
export function stripAnsi(text) {
  return String(text).replace(ANSI_SGR_RE, '');
}

/**
 * URL of a container's web UI as reachable from this browser.
 * @param {{hostPort:number|null, path?:string}|null|undefined} webUI
 * @param {string} [hostname=location.hostname]
 * @returns {string|null}
 */
export function webUiUrl(webUI, hostname = location.hostname) {
  if (!webUI || webUI.hostPort === null || webUI.hostPort === undefined) return null;
  return `http://${hostname}:${webUI.hostPort}${webUI.path || '/'}`;
}

/**
 * URL of a container's API docs, or null when the app has none.
 * @param {{hostPort:number|null, docsPath?:string|null}|null|undefined} webUI
 * @param {string} [hostname=location.hostname]
 */
export function docsUrl(webUI, hostname = location.hostname) {
  if (!webUI || !webUI.docsPath || webUI.hostPort === null || webUI.hostPort === undefined) return null;
  return `http://${hostname}:${webUI.hostPort}${webUI.docsPath}`;
}

/**
 * Debounce: call `fn` once `wait` ms after the last invocation.
 * @template {(...args: any[]) => void} F
 * @param {F} fn
 * @param {number} wait
 * @returns {F & { cancel(): void }}
 */
export function debounce(fn, wait) {
  let timer = null;
  const wrapped = /** @type {any} */ ((...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  });
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}

/**
 * Parse "KEY=VALUE" lines into an object; blank lines and '#' comments are
 * skipped, invalid lines throw.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvLines(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, eq))) {
      throw new Error(`Invalid environment line: "${raw}" (expected KEY=VALUE)`);
    }
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/** "1 flow" / "3 flows". @param {number} n @param {string} word */
export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
