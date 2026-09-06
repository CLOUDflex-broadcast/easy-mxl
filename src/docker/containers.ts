/**
 * Container listing, inspection, lifecycle operations and the
 * `ContainerSummary` projection used by the API and the frontend.
 *
 * Every function takes the Dockerode instance as first argument so tests can
 * pass fakes. Docker errors are converted with `toHttpError`; a 304 from
 * start/stop ("already in that state") is treated as success.
 */
import { posix as path } from 'node:path';
import { HttpError, toHttpError } from '../errors.js';
import { log } from '../log.js';

/** Labels written on containers launched by EASY MXL. */
export const LABELS = {
  managed: 'easy-mxl.managed',
  app: 'easy-mxl.app',
  domain: 'easy-mxl.domain',
  domainPath: 'easy-mxl.domainPath',
  webui: 'easy-mxl.webui',
  docs: 'easy-mxl.docs',
};

const DEFAULT_DOMAIN_ROOT = '/dev/shm/mxl';
const ZERO_TIME = '0001-01-01T00:00:00Z';
const TRUTHY_LABEL = new Set(['true', '1', 'yes']);

/**
 * Coerce a port value (number or numeric string) into an integer 1..65535.
 * @param {unknown} v
 * @returns {number|null}
 */
function toPort(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/**
 * Parse a `"9600/tcp"` key.
 * @param {string} key
 * @returns {{ containerPort: number, protocol: string }|null}
 */
function parsePortKey(key) {
  const [portPart, proto] = String(key).split('/');
  const containerPort = toPort(portPart);
  if (containerPort === null) return null;
  return { containerPort, protocol: (proto || 'tcp').toLowerCase() };
}

/**
 * Parse port information from either a `/containers/json` entry (`Ports`
 * array with `PrivatePort`/`PublicPort`/`Type`/`IP`) or an inspect-style map
 * (`NetworkSettings.Ports` / `HostConfig.PortBindings`:
 * `{ "9600/tcp": [{ HostIp, HostPort }] | null }`).
 *
 * @param {unknown} portsFromListOrInspect
 * @returns {{ ip: string|null, hostPort: number|null, containerPort: number, protocol: string }[]} deduplicated, sorted
 */
export function parsePorts(portsFromListOrInspect) {
  const out = [];
  if (Array.isArray(portsFromListOrInspect)) {
    for (const p of portsFromListOrInspect) {
      if (!p || typeof p !== 'object') continue;
      const containerPort = toPort(p.PrivatePort);
      if (containerPort === null) continue;
      out.push({
        ip: typeof p.IP === 'string' && p.IP ? p.IP : null,
        hostPort: toPort(p.PublicPort),
        containerPort,
        protocol: (typeof p.Type === 'string' && p.Type ? p.Type : 'tcp').toLowerCase(),
      });
    }
  } else if (portsFromListOrInspect && typeof portsFromListOrInspect === 'object') {
    for (const [key, value] of Object.entries(portsFromListOrInspect)) {
      const spec = parsePortKey(key);
      if (!spec) continue;
      if (!Array.isArray(value) || value.length === 0) {
        out.push({ ip: null, hostPort: null, ...spec });
        continue;
      }
      for (const b of value) {
        out.push({
          ip: b && typeof b.HostIp === 'string' && b.HostIp ? b.HostIp : null,
          hostPort: toPort(b && b.HostPort),
          ...spec,
        });
      }
    }
  }
  const seen = new Set();
  const unique = out.filter((p) => {
    const k = `${p.ip}|${p.hostPort}|${p.containerPort}|${p.protocol}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  unique.sort((a, b) =>
    a.containerPort - b.containerPort
    || a.protocol.localeCompare(b.protocol)
    || (a.hostPort ?? 0) - (b.hostPort ?? 0)
    || String(a.ip).localeCompare(String(b.ip)));
  return unique;
}

/** @param {unknown} name */
const stripSlash = (name) => (typeof name === 'string' ? name.replace(/^\//, '') : '');

/**
 * @param {unknown} value ISO string (inspect) or unix seconds (list)
 * @returns {string|null}
 */
function toIso(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === 'string' && value && value !== ZERO_TIME) {
    return Number.isNaN(Date.parse(value)) ? null : value;
  }
  return null;
}

/**
 * Relative path of `p` inside `root`, `''` when equal, `null` when outside.
 * Segment-aware: `/dev/shm/mxl2` is not inside `/dev/shm/mxl`.
 *
 * @param {string} root
 * @param {unknown} p
 * @returns {string|null}
 */
function relativeUnder(root, p) {
  if (typeof p !== 'string' || !p.startsWith('/')) return null;
  const rel = path.relative(path.normalize(root), path.normalize(p));
  if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) return null;
  return rel;
}

/**
 * Build a human status string for inspect objects (the list API already
 * provides one).
 * @param {object} state inspect `State`
 * @returns {string}
 */
function describeState(state) {
  const status = state.Status || 'unknown';
  switch (status) {
    case 'running':
      return state.StartedAt && state.StartedAt !== ZERO_TIME ? `Up since ${state.StartedAt}` : 'Up';
    case 'paused':
      return 'Up (Paused)';
    case 'exited':
      return `Exited (${typeof state.ExitCode === 'number' ? state.ExitCode : '?'})`;
    case 'removing':
      return 'Removal In Progress';
    default:
      return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

/**
 * Parse the `easy-mxl.webui` label (`"<containerPort>:<path>"`).
 * @param {unknown} value
 * @returns {{ containerPort: number, path: string }|null}
 */
function parseWebUiLabel(value) {
  if (typeof value !== 'string') return null;
  const idx = value.indexOf(':');
  const containerPort = toPort(idx === -1 ? value : value.slice(0, idx));
  if (containerPort === null) return null;
  const p = idx === -1 ? '' : value.slice(idx + 1);
  return { containerPort, path: p.startsWith('/') ? p : '/' };
}

/**
 * Look up a catalog app in `ctx.catalogById` (Map or plain object).
 * @param {unknown} catalogById
 * @param {string|null} appId
 * @returns {object|null}
 */
function lookupApp(catalogById, appId) {
  if (!appId || !catalogById) return null;
  if (catalogById instanceof Map) return catalogById.get(appId) || null;
  if (typeof catalogById === 'object') return catalogById[appId] || null;
  return null;
}

/**
 * Resolve the web UI description: label > catalog > first published tcp port.
 *
 * @param {object} labels
 * @param {object|null} catalogApp
 * @param {ReturnType<typeof parsePorts>} ports
 * @param {string|null} networkMode
 * @returns {{ containerPort: number, hostPort: number|null, path: string, docsPath: string|null, inferred: boolean }|null}
 */
function resolveWebUI(labels, catalogApp, ports, networkMode) {
  const hostNet = networkMode === 'host';
  const hostPortFor = (containerPort, fallback) => {
    const published = ports.find((p) => p.containerPort === containerPort && p.protocol === 'tcp' && p.hostPort !== null);
    if (published) return published.hostPort;
    if (hostNet) return containerPort;
    return fallback;
  };

  const fromLabel = parseWebUiLabel(labels[LABELS.webui]);
  const docsLabel = typeof labels[LABELS.docs] === 'string' && labels[LABELS.docs] ? labels[LABELS.docs] : null;
  if (fromLabel) {
    const docsPath = docsLabel ?? (catalogApp && catalogApp.webUI && catalogApp.webUI.docsPath) ?? null;
    return { ...fromLabel, hostPort: hostPortFor(fromLabel.containerPort, null), docsPath, inferred: false };
  }

  if (catalogApp && catalogApp.webUI && toPort(catalogApp.webUI.containerPort) !== null) {
    const ui = catalogApp.webUI;
    const declared = (catalogApp.ports || []).find((p) => p.containerPort === ui.containerPort && (p.protocol || 'tcp') === 'tcp');
    const fallback = declared && toPort(declared.hostPort) !== null ? declared.hostPort : null;
    return {
      containerPort: ui.containerPort,
      hostPort: hostPortFor(ui.containerPort, fallback),
      path: typeof ui.path === 'string' && ui.path.startsWith('/') ? ui.path : '/',
      docsPath: docsLabel ?? (typeof ui.docsPath === 'string' ? ui.docsPath : null),
      inferred: false,
    };
  }

  const first = ports.find((p) => p.protocol === 'tcp' && p.hostPort !== null);
  if (first) {
    return { containerPort: first.containerPort, hostPort: first.hostPort, path: '/', docsPath: docsLabel, inferred: true };
  }
  return null;
}

/**
 * Project a Docker container (either a `/containers/json` list entry or a full
 * inspect object) onto the `ContainerSummary` shape from DESIGN.md §5.2.
 * Never throws for missing fields.
 *
 * @param {object} entry list entry or inspect object
 * @param {{ domainRoot?: string, catalogById?: Map<string, object>|object }} [ctx]
 * @returns {object} ContainerSummary
 */
export function summarize(entry, ctx = {}) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const isList = Array.isArray(e.Names);
  const domainRoot = (ctx && ctx.domainRoot) || DEFAULT_DOMAIN_ROOT;
  const config = isList ? {} : (e.Config && typeof e.Config === 'object' ? e.Config : {});
  const hostConfig = e.HostConfig && typeof e.HostConfig === 'object' ? e.HostConfig : {};
  const inspectState = !isList && e.State && typeof e.State === 'object' ? e.State : {};

  const id = typeof e.Id === 'string' ? e.Id : '';
  const name = isList ? stripSlash(e.Names[0]) : stripSlash(e.Name);
  const state = isList ? (typeof e.State === 'string' ? e.State : 'unknown') : (inspectState.Status || 'unknown');
  const labels = { ...((isList ? e.Labels : config.Labels) || {}) };
  const networkMode = typeof hostConfig.NetworkMode === 'string' && hostConfig.NetworkMode ? hostConfig.NetworkMode : null;

  let ports;
  if (isList) {
    ports = parsePorts(e.Ports);
  } else {
    const live = parsePorts(e.NetworkSettings && e.NetworkSettings.Ports);
    ports = live.some((p) => p.hostPort !== null) || !hostConfig.PortBindings ? live : parsePorts(hostConfig.PortBindings);
  }

  const mounts = (Array.isArray(e.Mounts) ? e.Mounts : [])
    .filter((m) => m && typeof m === 'object')
    .map((m) => ({
      type: typeof m.Type === 'string' ? m.Type : 'bind',
      source: typeof m.Source === 'string' ? m.Source : (typeof m.Name === 'string' ? m.Name : ''),
      destination: typeof m.Destination === 'string' ? m.Destination : '',
      readOnly: m.RW === false,
    }));

  const domainMounts = [];
  let domain = null;
  let domainPath = null;
  for (const m of mounts) {
    const rel = relativeUnder(domainRoot, m.source);
    if (rel === null) continue;
    domainMounts.push({ source: m.source, destination: m.destination, readOnly: m.readOnly });
    if (rel !== '' && domain === null) {
      domain = rel.split('/')[0];
      domainPath = path.join(domainRoot, domain);
    }
  }
  if (typeof labels[LABELS.domain] === 'string' && labels[LABELS.domain]) {
    domain = labels[LABELS.domain];
    domainPath = typeof labels[LABELS.domainPath] === 'string' && labels[LABELS.domainPath]
      ? labels[LABELS.domainPath]
      : path.join(domainRoot, domain);
  }

  const app = typeof labels[LABELS.app] === 'string' && labels[LABELS.app] ? labels[LABELS.app] : null;
  const catalogApp = lookupApp(ctx && ctx.catalogById, app);
  const restartName = hostConfig.RestartPolicy && typeof hostConfig.RestartPolicy.Name === 'string' ? hostConfig.RestartPolicy.Name : '';

  let cmd = null;
  if (isList) {
    cmd = typeof e.Command === 'string' && e.Command.trim() ? e.Command.trim().split(/\s+/) : null;
  } else if (Array.isArray(config.Cmd)) {
    cmd = config.Cmd.map(String);
  }

  return {
    id,
    shortId: id.slice(0, 12),
    name,
    image: isList ? (typeof e.Image === 'string' ? e.Image : '') : (typeof config.Image === 'string' ? config.Image : ''),
    imageId: isList ? (typeof e.ImageID === 'string' ? e.ImageID : '') : (typeof e.Image === 'string' ? e.Image : ''),
    state,
    status: isList ? (typeof e.Status === 'string' ? e.Status : '') : describeState(inspectState),
    created: toIso(e.Created) || '',
    startedAt: isList ? null : toIso(inspectState.StartedAt),
    finishedAt: isList ? null : toIso(inspectState.FinishedAt),
    exitCode: !isList && state !== 'running' && typeof inspectState.ExitCode === 'number' ? inspectState.ExitCode : null,
    ports,
    labels,
    managed: TRUTHY_LABEL.has(String(labels[LABELS.managed]).toLowerCase()),
    app,
    webUI: resolveWebUI(labels, catalogApp, ports, networkMode),
    domain,
    domainPath,
    domainMounts,
    mounts,
    networkMode,
    restartPolicy: restartName || null,
    cmd,
    tty: !isList && config.Tty === true,
  };
}

/**
 * Validate a container reference (id, short id or name).
 * @param {unknown} id
 * @returns {string}
 */
function requireId(id) {
  if (typeof id !== 'string' || !id.trim()) {
    throw new HttpError(400, 'invalid_container_id', 'Container id or name is required');
  }
  return id.trim();
}

/**
 * Validate a stop/restart timeout in seconds.
 * @param {unknown} timeout
 * @returns {number}
 */
function requireTimeout(timeout) {
  const t = timeout === undefined || timeout === null ? 10 : Number(timeout);
  if (!Number.isInteger(t) || t < 0 || t > 3600) {
    throw new HttpError(400, 'invalid_timeout', 'timeout must be an integer number of seconds between 0 and 3600');
  }
  return t;
}

/**
 * Run a container operation, treating 304 as success and converting errors.
 * @param {import('dockerode')} docker
 * @param {string} id
 * @param {(container: import('dockerode').Container) => Promise<unknown>} op
 * @returns {Promise<void>}
 */
async function containerOp(docker, id, op) {
  const container = docker.getContainer(requireId(id));
  try {
    await op(container);
  } catch (err) {
    if (err && err.statusCode === 304) return;
    throw toHttpError(err);
  }
}

/**
 * List all containers (running and stopped) as summaries. Entries that cannot
 * be summarised are skipped with a warning instead of failing the whole list.
 *
 * @param {import('dockerode')} docker
 * @param {{ domainRoot?: string, catalogById?: Map<string, object> }} [ctx]
 * @returns {Promise<object[]>} ContainerSummary[]
 */
export async function listContainers(docker, ctx = {}) {
  let entries;
  try {
    entries = await docker.listContainers({ all: true });
  } catch (err) {
    throw toHttpError(err);
  }
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    try {
      out.push(summarize(entry, ctx));
    } catch (err) {
      log.warn('skipping container that could not be summarised', { id: entry && entry.Id, error: err });
    }
  }
  return out;
}

/**
 * Inspect one container.
 *
 * @param {import('dockerode')} docker
 * @param {string} id full id, short id or name
 * @param {{ domainRoot?: string, catalogById?: Map<string, object> }} [ctx]
 * @returns {Promise<{ summary: object, inspect: object }>}
 * @throws {HttpError} 404 when unknown
 */
export async function inspectContainer(docker, id, ctx = {}) {
  let inspect;
  try {
    inspect = await docker.getContainer(requireId(id)).inspect();
  } catch (err) {
    throw toHttpError(err);
  }
  return { summary: summarize(inspect, ctx), inspect };
}

/**
 * Start a container (already running → success).
 * @param {import('dockerode')} docker
 * @param {string} id
 * @returns {Promise<void>}
 */
export function startContainer(docker, id) {
  return containerOp(docker, id, (c) => c.start());
}

/**
 * Stop a container (already stopped → success).
 * @param {import('dockerode')} docker
 * @param {string} id
 * @param {{ timeout?: number }} [opts] seconds to wait before SIGKILL
 * @returns {Promise<void>}
 */
export async function stopContainer(docker, id, { timeout = 10 } = {}) {
  const t = requireTimeout(timeout);
  return containerOp(docker, id, (c) => c.stop({ t }));
}

/**
 * Restart a container.
 * @param {import('dockerode')} docker
 * @param {string} id
 * @param {{ timeout?: number }} [opts] seconds to wait before SIGKILL
 * @returns {Promise<void>}
 */
export async function restartContainer(docker, id, { timeout = 10 } = {}) {
  const t = requireTimeout(timeout);
  return containerOp(docker, id, (c) => c.restart({ t }));
}

/**
 * Kill a container (SIGKILL).
 * @param {import('dockerode')} docker
 * @param {string} id
 * @returns {Promise<void>}
 */
export function killContainer(docker, id) {
  return containerOp(docker, id, (c) => c.kill());
}

/**
 * Remove a container.
 * @param {import('dockerode')} docker
 * @param {string} id
 * @param {{ force?: boolean, volumes?: boolean }} [opts]
 * @returns {Promise<void>}
 */
export function removeContainer(docker, id, { force = false, volumes = false } = {}) {
  return containerOp(docker, id, (c) => c.remove({ force: !!force, v: !!volumes }));
}
