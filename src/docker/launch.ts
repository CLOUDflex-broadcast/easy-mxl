/**
 * Launching catalog apps: pure container-create option building plus the
 * orchestration (domain → dependencies → pull → conflict check → create → start).
 */
import { posix as path } from 'node:path';
import { HttpError, toHttpError } from '../errors.js';
import { log } from '../log.js';
import { LABELS } from './containers.js';
import { imagePresent, listLocalImages, pullImage } from './images.js';
import { CONTAINER_NAME_RE, VOLUME_NAME_RE, expandPorts, imageRepositoryOf, parseByteSize, renderTemplate } from '../catalog.js';

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VERSION_LABEL = 'easy-mxl.version';
const IMAGE_LABEL = 'easy-mxl.image';
const ACTIVE_STATES = new Set(['running', 'restarting', 'paused']);
/** Docker image reference: [registry[:port]/]repo[/…][:tag][@sha256:…] (lowercase repo). */
const IMAGE_REF_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::\d{1,5}(?=\/))?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[\w][\w.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$/;
/** Host paths that must never be bind-mounted into a media-function container. */
const DENIED_HOST_PATHS = new Set(['/', '/proc', '/sys', '/boot', '/etc', '/dev', '/var/run/docker.sock', '/run/docker.sock']);

/** @param {unknown} name */
const stripSlash = (name) => (typeof name === 'string' ? name.replace(/^\//, '') : '');

/**
 * @param {string} code
 * @param {string} message
 * @param {unknown} [details]
 * @returns {HttpError}
 */
const bad = (code, message, details) => new HttpError(400, code, message, details);

/**
 * Pick and validate the container name.
 * @param {object} app
 * @param {object} params
 * @returns {string}
 */
function resolveName(app, params) {
  const override = params.name === undefined || params.name === null ? '' : String(params.name).trim();
  const name = override || app.containerName || app.id;
  if (typeof name !== 'string' || !CONTAINER_NAME_RE.test(name)) {
    throw bad('invalid_name', `Invalid container name "${name}": use letters, digits, "_", "." or "-" (at least 2 characters, starting with a letter or digit)`, { name });
  }
  return name;
}

/**
 * Template values: built-ins (`containerName`, `domainName`, `domainContainerPath`), then app
 * param defaults, then `params.params` overrides.
 * @param {object} app
 * @param {object} params
 * @param {Record<string, unknown>} [builtins]
 * @returns {Record<string, string>}
 */
function resolveTemplateVars(app, params, builtins = {}) {
  const vars = {};
  for (const [key, value] of Object.entries(builtins)) vars[key] = value === undefined || value === null ? '' : String(value);
  for (const p of app.params || []) {
    if (p && typeof p.key === 'string' && p.default !== undefined && p.default !== null) vars[p.key] = String(p.default);
  }
  const overrides = params.params && typeof params.params === 'object' ? params.params : {};
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') throw bad('invalid_param', `Parameter "${key}" must be a string`, { key });
    vars[key] = String(value);
  }
  for (const p of app.params || []) {
    if (p && typeof p.key === 'string' && !(p.key in vars)) {
      throw bad('missing_param', `Parameter "${p.label || p.key}" is required`, { key: p.key });
    }
  }
  return vars;
}

/**
 * `KEY=VALUE` list: app env (templated) → domain env var → user env.
 * A `null` user value removes a variable.
 * @param {object} app
 * @param {object} params
 * @param {Record<string, string>} vars
 * @returns {string[]}
 */
function buildEnv(app, params, vars) {
  const env = new Map();
  const set = (key, value, source) => {
    if (!ENV_NAME_RE.test(key)) throw bad('invalid_env', `Invalid environment variable name "${key}" (${source})`, { key });
    env.set(key, String(value));
  };
  for (const [key, value] of Object.entries(app.env || {})) {
    set(key, renderTemplate(String(value), vars), `app "${app.id}"`);
  }
  if (app.domainMount && app.domainMount.envVar) {
    set(app.domainMount.envVar, app.domainMount.containerPath, 'domainMount.envVar');
  }
  const extra = params.env && typeof params.env === 'object' ? params.env : {};
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null) {
      env.delete(key);
      continue;
    }
    if (typeof value === 'object') throw bad('invalid_env', `Environment variable "${key}" must be a string`, { key });
    set(key, value, 'launch parameters');
  }
  return [...env].map(([key, value]) => `${key}=${value}`);
}

/**
 * @param {string} hostPath
 * @param {string} containerPath
 * @param {boolean|undefined} readOnly
 * @returns {string}
 */
const bindSpec = (hostPath, containerPath, readOnly) => `${hostPath}:${containerPath}${readOnly ? ':ro' : ''}`;

/**
 * Binds for `app.hostPaths` from `params.hostPaths` / defaults.
 * @param {object} app
 * @param {object} params
 * @returns {string[]}
 */
function buildHostPathBinds(app, params) {
  const supplied = params.hostPaths && typeof params.hostPaths === 'object' ? params.hostPaths : {};
  const binds = [];
  for (const hp of app.hostPaths || []) {
    if (!hp || typeof hp.key !== 'string') continue;
    const given = supplied[hp.key];
    const raw = given !== undefined && given !== null && String(given).trim() !== '' ? String(given).trim() : (hp.default || '');
    if (!raw) {
      if (hp.required) {
        throw bad('missing_host_path', `"${hp.label || hp.key}" is required: provide a host path for "${hp.key}"`, { key: hp.key });
      }
      continue;
    }
    if (!path.isAbsolute(raw)) {
      throw bad('invalid_host_path', `Host path for "${hp.key}" must be absolute (got "${raw}")`, { key: hp.key, value: raw });
    }
    if (raw.includes(':')) {
      throw bad('invalid_host_path', `Host path for "${hp.key}" must not contain ":"`, { key: hp.key, value: raw });
    }
    const normalized = path.normalize(raw).replace(/\/+$/, '') || '/';
    if (DENIED_HOST_PATHS.has(normalized) || normalized.endsWith('/docker.sock')) {
      throw bad('forbidden_host_path', `Host path "${normalized}" cannot be mounted into a media-function container`, { key: hp.key, value: normalized });
    }
    binds.push(bindSpec(normalized, hp.containerPath, hp.readOnly));
  }
  return binds;
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {number}
 */
function toHostPort(value, key) {
  const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw bad('invalid_host_port', `Host port for ${key} must be an integer between 1 and 65535 (got ${JSON.stringify(value)})`, { key, value });
  }
  return n;
}

/**
 * ExposedPorts + PortBindings from the catalog ports and `params.hostPorts`.
 * A `null` override leaves the port exposed but unpublished.
 * @param {object} app
 * @param {object} params
 * @param {boolean} hostNetwork
 * @returns {{ exposed: object, bindings: object }}
 */
function buildPorts(app, params, hostNetwork) {
  const exposed = {};
  const bindings = {};
  const usedHostPorts = new Map();
  const expanded = expandPorts(app);
  const known = new Set(expanded.map((p) => `${p.containerPort}/${p.protocol}`));
  const overrides = new Map();
  const rawOverrides = params.hostPorts && typeof params.hostPorts === 'object' ? params.hostPorts : {};
  for (const [rawKey, value] of Object.entries(rawOverrides)) {
    const key = rawKey.includes('/') ? rawKey.toLowerCase() : `${rawKey}/tcp`;
    if (!known.has(key)) throw bad('unknown_port', `App "${app.id}" does not declare port ${rawKey}`, { key: rawKey });
    overrides.set(key, value);
  }
  // Overriding the first host port of a range moves the whole range by the same offset, so a
  // range stays contiguous unless individual members are overridden explicitly.
  const shifted = new Map();
  for (const entry of app.ports || []) {
    if (!entry || !Number.isInteger(entry.containerPort) || !Number.isInteger(entry.rangeEnd) || entry.rangeEnd <= entry.containerPort) continue;
    const proto = typeof entry.protocol === 'string' && entry.protocol ? entry.protocol.toLowerCase() : 'tcp';
    const startKey = `${entry.containerPort}/${proto}`;
    if (!overrides.has(startKey)) continue;
    const startValue = overrides.get(startKey);
    const unpublish = startValue === null || startValue === '';
    const base = unpublish ? null : toHostPort(startValue, startKey);
    const span = entry.rangeEnd - entry.containerPort;
    if (base !== null && base + span > 65535) {
      throw bad('invalid_host_port', `Host port ${base} for ${startKey} pushes the range of ${span + 1} ports past 65535`, { key: startKey, value: startValue });
    }
    for (let cp = entry.containerPort + 1; cp <= entry.rangeEnd; cp++) {
      const key = `${cp}/${proto}`;
      if (!overrides.has(key)) shifted.set(key, base === null ? null : base + (cp - entry.containerPort));
    }
  }
  for (const p of expanded) {
    const key = `${p.containerPort}/${p.protocol}`;
    exposed[key] = {};
    let hostPort = p.hostPort;
    if (overrides.has(key)) {
      const value = overrides.get(key);
      hostPort = value === null || value === '' ? null : toHostPort(value, key);
    } else if (shifted.has(key)) {
      hostPort = shifted.get(key);
    }
    if (hostPort === null || hostNetwork) continue;
    const hostKey = `${hostPort}/${p.protocol}`;
    if (usedHostPorts.has(hostKey)) {
      throw bad('duplicate_host_port', `Host port ${hostKey} is mapped to both ${usedHostPorts.get(hostKey)} and ${key}`, { hostPort, protocol: p.protocol });
    }
    usedHostPorts.set(hostKey, key);
    bindings[key] = [{ HostPort: String(hostPort) }];
  }
  return { exposed, bindings };
}

/**
 * The image reference to run: `params.image` when given (validated as a Docker reference;
 * for `imagePolicy: local` it must stay in the app's repository), else `app.image`.
 *
 * @param {object} app catalog App
 * @param {object} [params] LaunchParams
 * @returns {string}
 * @throws {HttpError} 400 `invalid_image` | `image_repository_mismatch`
 */
export function resolveImageRef(app, params = {}) {
  const raw = params && params.image !== undefined && params.image !== null ? String(params.image).trim() : '';
  if (!raw) return app.image;
  if (!IMAGE_REF_RE.test(raw)) {
    throw bad('invalid_image', `Invalid image reference "${raw}"`, { image: raw });
  }
  if (app.imagePolicy === 'local') {
    const repositories = allowedRepositories(app);
    if (!repositories.includes(imageRepositoryOf(raw))) {
      throw bad('image_repository_mismatch', `App "${app.id}" runs the locally loaded image repositor${repositories.length === 1 ? 'y' : 'ies'} ${repositories.map((r) => `"${r}"`).join(', ')}; "${raw}" belongs to another repository`, { image: raw, repository: repositories[0], repositories });
    }
  }
  return raw;
}

/**
 * Repositories a locally loaded image may come from (`imageRepositories`, else
 * `imageRepository`, else derived from `image`). Architecture-specific deliveries use one
 * repository per CPU architecture.
 * @param {object} app
 * @returns {string[]}
 */
function allowedRepositories(app) {
  if (Array.isArray(app.imageRepositories) && app.imageRepositories.length) return app.imageRepositories.map(String);
  return [app.imageRepository || imageRepositoryOf(app.image)];
}

/**
 * Validate the launch-policy parameters that do not influence the create options.
 * @param {object} app
 * @param {object} p
 */
function validatePolicies(app, p) {
  if (p.pull !== undefined && p.pull !== null && p.pull !== 'missing' && p.pull !== 'always') {
    throw bad('invalid_pull_policy', `pull must be "missing" or "always" (got ${JSON.stringify(p.pull)})`);
  }
  if (app.imagePolicy === 'local' && p.pull === 'always') {
    throw bad('invalid_pull_policy', `App "${app.id}" runs a locally loaded image (docker load); it cannot be pulled`);
  }
  if (p.launchRequires !== undefined && p.launchRequires !== null && typeof p.launchRequires !== 'boolean') {
    throw bad('invalid_launch_requires', `launchRequires must be a boolean (got ${JSON.stringify(p.launchRequires)})`);
  }
}

/**
 * Build the Docker create options for an app (pure, no I/O).
 *
 * @param {object} app catalog App
 * @param {object} params LaunchParams (DESIGN.md §5.4, §13.2)
 * @param {{ domain: { name: string, path: string }|null, config?: { version?: string } }} ctx
 * @returns {{ name: string, image: string, createOptions: object }}
 * @throws {HttpError} 400 on validation failures
 */
export function buildCreateOptions(app, params = {}, ctx = {}) {
  if (!app || typeof app !== 'object' || typeof app.id !== 'string' || typeof app.image !== 'string') {
    throw bad('invalid_app', 'buildCreateOptions: app must be a catalog App with id and image');
  }
  const p = params && typeof params === 'object' ? params : {};
  const domain = ctx && ctx.domain ? ctx.domain : null;
  const config = ctx && ctx.config && typeof ctx.config === 'object' ? ctx.config : {};
  const hostNetwork = app.networkMode === 'host';

  validatePolicies(app, p);
  const name = resolveName(app, p);
  const image = resolveImageRef(app, p);
  const vars = resolveTemplateVars(app, p, {
    containerName: name,
    domainName: domain ? String(domain.name ?? path.basename(String(domain.path || ''))) : '',
    domainContainerPath: app.domainMount ? app.domainMount.containerPath : '',
  });
  const env = buildEnv(app, p, vars);
  const cmd = Array.isArray(app.cmd) ? app.cmd.map((s) => renderTemplate(String(s), vars)) : null;
  const entrypoint = Array.isArray(app.entrypoint) ? app.entrypoint.map((s) => renderTemplate(String(s), vars)) : null;

  const binds = [];
  if (app.domainMount) {
    if (!domain || typeof domain.path !== 'string' || !path.isAbsolute(domain.path)) {
      throw bad('domain_required', `App "${app.id}" mounts an MXL domain at ${app.domainMount.containerPath}: choose a domain`, { app: app.id });
    }
    binds.push(bindSpec(domain.path.replace(/\/+$/, ''), app.domainMount.containerPath, app.domainMount.readOnly));
  }
  binds.push(...buildHostPathBinds(app, p));
  for (const v of app.volumes || []) {
    if (!v || typeof v.name !== 'string' || typeof v.containerPath !== 'string') continue;
    const volumeName = renderTemplate(v.name, vars);
    if (!VOLUME_NAME_RE.test(volumeName)) {
      throw bad('invalid_volume_name', `App "${app.id}": "${volumeName}" is not a valid Docker volume name`, { name: volumeName });
    }
    binds.push(bindSpec(volumeName, v.containerPath, v.readOnly));
  }

  const { exposed, bindings } = buildPorts(app, p, hostNetwork);

  const labels = {
    [LABELS.managed]: 'true',
    [LABELS.app]: app.id,
    [VERSION_LABEL]: String(config.version ?? 'unknown'),
    [IMAGE_LABEL]: image,
  };
  if (app.domainMount && domain) {
    labels[LABELS.domain] = String(domain.name ?? path.basename(domain.path));
    labels[LABELS.domainPath] = domain.path.replace(/\/+$/, '');
  }
  if (app.webUI && Number.isInteger(app.webUI.containerPort)) {
    labels[LABELS.webui] = `${app.webUI.containerPort}:${typeof app.webUI.path === 'string' && app.webUI.path ? app.webUI.path : '/'}`;
    if (typeof app.webUI.docsPath === 'string' && app.webUI.docsPath) labels[LABELS.docs] = app.webUI.docsPath;
  }

  const hostConfig = { RestartPolicy: { Name: app.restartPolicy || 'no' } };
  if (binds.length) hostConfig.Binds = binds;
  if (!hostNetwork && Object.keys(bindings).length) hostConfig.PortBindings = bindings;
  if (typeof app.networkMode === 'string' && app.networkMode) hostConfig.NetworkMode = app.networkMode;
  if (typeof app.ipcMode === 'string' && app.ipcMode) hostConfig.IpcMode = app.ipcMode;
  if (Array.isArray(app.extraHosts) && app.extraHosts.length) hostConfig.ExtraHosts = app.extraHosts.map(String);
  if (app.shmSize !== undefined && app.shmSize !== null) {
    try {
      hostConfig.ShmSize = parseByteSize(app.shmSize);
    } catch (err) {
      throw bad('invalid_shm_size', `App "${app.id}": ${err.message}`, { shmSize: app.shmSize });
    }
  }
  if (app.init) hostConfig.Init = true;

  const createOptions = {
    name,
    Image: image,
    Env: env,
    Labels: labels,
    Tty: !!app.tty,
    OpenStdin: !!app.stdinOpen,
    HostConfig: hostConfig,
  };
  // Docker rejects a hostname together with host networking.
  if (!hostNetwork) createOptions.Hostname = name;
  if (Object.keys(exposed).length) createOptions.ExposedPorts = exposed;
  if (cmd) createOptions.Cmd = cmd;
  if (entrypoint) createOptions.Entrypoint = entrypoint;
  if (typeof app.user === 'string' && app.user) createOptions.User = app.user;

  return { name, image, createOptions };
}

/**
 * Is a container with this name already present?
 *
 * @param {import('dockerode')} docker
 * @param {string} name
 * @returns {Promise<{ id: string, name: string, state: string }|null>}
 */
export async function checkNameConflict(docker, name) {
  try {
    const info = await docker.getContainer(name).inspect();
    return {
      id: info.Id,
      name: stripSlash(info.Name) || name,
      state: (info.State && info.State.Status) || 'unknown',
    };
  } catch (err) {
    if (err && err.statusCode === 404) return null;
    throw toHttpError(err);
  }
}

/**
 * @param {object} c list entry or inspect object
 * @returns {{ id: string, name: string, state: string }}
 */
function brief(c) {
  return {
    id: c.Id,
    name: stripSlash(Array.isArray(c.Names) ? c.Names[0] : c.Name),
    state: typeof c.State === 'string' ? c.State : ((c.State && c.State.Status) || 'unknown'),
  };
}

/**
 * Does any container bind this host port? Containers are first matched via the
 * list API `Ports`; every other container is inspected so its configured
 * `HostConfig.PortBindings` counts as well (stopped containers, or daemons that
 * do not publish ports). Prefers a running match.
 *
 * @param {import('dockerode')} docker
 * @param {number|string} hostPort
 * @param {string} [protocol]
 * @returns {Promise<{ id: string, name: string, state: string }|null>}
 */
export async function findHostPortUsage(docker, hostPort, protocol = 'tcp') {
  const port = toHostPort(hostPort, 'port');
  const proto = String(protocol || 'tcp').toLowerCase();
  let entries;
  try {
    entries = await docker.listContainers({ all: true });
  } catch (err) {
    throw toHttpError(err);
  }
  const matches = [];
  const toInspect = [];
  for (const c of Array.isArray(entries) ? entries : []) {
    const published = (Array.isArray(c.Ports) ? c.Ports : []).some(
      (p) => p && Number(p.PublicPort) === port && String(p.Type || 'tcp').toLowerCase() === proto,
    );
    if (published) matches.push(brief(c));
    else toInspect.push(c);
  }
  const running = matches.find((m) => ACTIVE_STATES.has(m.state));
  if (running) return running;

  const inspected = await Promise.allSettled(toInspect.map((c) => docker.getContainer(c.Id).inspect()));
  for (const r of inspected) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    const info = r.value;
    const sources = [info.HostConfig && info.HostConfig.PortBindings, info.NetworkSettings && info.NetworkSettings.Ports];
    const bound = sources.some((map) => map && typeof map === 'object' && Object.entries(map).some(([key, list]) => {
      const keyProto = (key.split('/')[1] || 'tcp').toLowerCase();
      return keyProto === proto && Array.isArray(list) && list.some((b) => b && Number(b.HostPort) === port);
    }));
    if (bound) matches.push(brief(info));
  }
  return matches.find((m) => ACTIVE_STATES.has(m.state)) || matches[0] || null;
}

/**
 * Find a catalog app in a Map or plain object index.
 * @param {unknown} catalogById
 * @param {string} id
 * @returns {object|null}
 */
function lookupApp(catalogById, id) {
  if (!catalogById) return null;
  if (catalogById instanceof Map) return catalogById.get(id) || null;
  return typeof catalogById === 'object' ? catalogById[id] || null : null;
}

/**
 * Resolve the Domain object for an app that mounts a domain.
 * @param {object} app
 * @param {object} params
 * @param {object} ctx
 * @param {object} hooks
 * @returns {Promise<object|null>}
 */
async function resolveDomain(app, params, ctx, hooks) {
  if (!app.domainMount) return null;
  const name = params.domain === undefined || params.domain === null ? '' : String(params.domain).trim();
  if (!name) return null; // buildCreateOptions reports domain_required
  let domain;
  if (typeof ctx.getDomain === 'function') {
    domain = await ctx.getDomain(name);
  } else if (typeof hooks.listDomains === 'function') {
    const list = await hooks.listDomains();
    domain = (Array.isArray(list) ? list : []).find((d) => d && d.name === name);
  } else {
    throw new HttpError(500, 'domain_resolver_missing', 'launchApp needs ctx.getDomain(name) or hooks.listDomains() to resolve domains');
  }
  if (!domain || typeof domain.path !== 'string') {
    throw new HttpError(404, 'domain_not_found', `Domain "${name}" does not exist`, { name });
  }
  return domain;
}

/**
 * Make sure a required app is running: skip when running, start when stopped,
 * launch recursively when absent.
 *
 * @returns {Promise<{ app: string, id: string, name: string, action: 'started'|'created'|'already-running' }[]>}
 */
async function ensureDependency(docker, parent, depId, params, ctx, hooks, onProgress) {
  const depApp = lookupApp(hooks.catalogById || ctx.catalogById, depId);
  if (!depApp) {
    throw bad('unknown_dependency', `App "${parent.id}" requires "${depId}", which is not in the catalog (or is disabled). Set launchRequires=false to launch without it.`, { app: parent.id, dependency: depId });
  }
  let existing;
  try {
    existing = await docker.listContainers({ all: true, filters: { label: [`${LABELS.app}=${depId}`] } });
  } catch (err) {
    throw toHttpError(err);
  }
  const list = Array.isArray(existing) ? existing : [];
  const active = list.find((c) => ACTIVE_STATES.has(c.State));
  if (active) {
    const info = brief(active);
    const entry = { app: depId, id: info.id, name: info.name, action: 'already-running' };
    onProgress('dependency', entry);
    return [entry];
  }
  const stopped = [...list].sort((a, b) => (Number(b.Created) || 0) - (Number(a.Created) || 0))[0];
  if (stopped) {
    const info = brief(stopped);
    onProgress('dependency', { app: depId, id: info.id, name: info.name, action: 'starting' });
    try {
      await docker.getContainer(stopped.Id).start();
    } catch (err) {
      if (!(err && err.statusCode === 304)) {
        const e = toHttpError(err);
        throw new HttpError(e.status, 'dependency_failed', `Could not start dependency "${depId}" (container ${info.name}): ${e.message}`, { app: depId, id: info.id, name: info.name });
      }
    }
    const entry = { app: depId, id: info.id, name: info.name, action: 'started' };
    onProgress('dependency', entry);
    return [entry];
  }
  // No labelled container: an unlabelled one with the dependency's name (e.g. from the hands-on
  // compose stack) is adopted rather than reported as the parent's name conflict.
  const depName = depApp.containerName || depApp.id;
  const conflict = await checkNameConflict(docker, depName);
  if (conflict) {
    if (ACTIVE_STATES.has(conflict.state)) {
      const entry = { app: depId, id: conflict.id, name: conflict.name, action: 'already-running' };
      onProgress('dependency', entry);
      return [entry];
    }
    onProgress('dependency', { app: depId, id: conflict.id, name: conflict.name, action: 'starting' });
    try {
      await docker.getContainer(conflict.id).start();
    } catch (err) {
      if (!(err && err.statusCode === 304)) {
        const e = toHttpError(err);
        throw new HttpError(409, 'dependency_conflict', `Dependency "${depId}" conflicts with the existing container ${conflict.name} (${conflict.state}), which could not be started: ${e.message}`, { app: depId, ...conflict });
      }
    }
    const entry = { app: depId, id: conflict.id, name: conflict.name, action: 'started' };
    onProgress('dependency', entry);
    return [entry];
  }
  onProgress('dependency', { app: depId, action: 'launching' });
  let result;
  try {
    result = await launchApp(docker, depApp, { domain: params.domain ?? null, pull: params.pull, launchRequires: true }, ctx, hooks);
  } catch (err) {
    if (err instanceof HttpError && err.code === 'name_conflict') {
      throw new HttpError(409, 'dependency_conflict', `Dependency "${depId}": ${err.message}`, { app: depId, ...(err.details || {}) });
    }
    throw err;
  }
  const entry = { app: depId, id: result.id, name: result.name, action: 'created' };
  onProgress('dependency', entry);
  return [...result.dependencies, entry];
}

/**
 * Launch an app: resolve domain → dependencies → pull → name check → create → start.
 *
 * `ctx`: `{ config, getDomain(name): Promise<Domain>, catalogById? }` — the
 * recursion adds `launchStack` (ids being launched) to detect dependency cycles.
 * `hooks`: `{ onProgress(stage, detail), catalogById?, listDomains? }` where
 * `stage` is `'pull'|'dependency'|'create'|'start'`.
 *
 * @param {import('dockerode')} docker
 * @param {object} app catalog App
 * @param {object} [params] LaunchParams
 * @param {object} [ctx]
 * @param {object} [hooks]
 * @returns {Promise<{ id: string, name: string, started: true, dependencies: { app: string, id: string, name: string, action: 'started'|'created'|'already-running' }[] }>}
 * @throws {HttpError} 400 validation, 404 domain/image, 409 `name_conflict` (details `{ id, name, state }`), 502 daemon errors
 */
export async function launchApp(docker, app, params = {}, ctx = {}, hooks = {}) {
  if (!app || typeof app !== 'object' || typeof app.id !== 'string') {
    throw bad('invalid_app', 'launchApp: app must be a catalog App');
  }
  const p = params && typeof params === 'object' ? params : {};
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const h = hooks && typeof hooks === 'object' ? hooks : {};
  const onProgress = (stage, detail) => {
    if (typeof h.onProgress !== 'function') return;
    try {
      h.onProgress(stage, detail);
    } catch (err) {
      log.warn('launch progress hook threw', { stage, error: err });
    }
  };
  const stack = Array.isArray(c.launchStack) ? c.launchStack : [];
  if (stack.includes(app.id)) {
    throw bad('dependency_cycle', `Dependency cycle: ${[...stack, app.id].join(' -> ')}`, { chain: [...stack, app.id] });
  }

  const domain = await resolveDomain(app, p, c, h);
  const { name, image, createOptions } = buildCreateOptions(app, p, { domain, config: c.config || {} });

  const dependencies = [];
  if (p.launchRequires !== false) {
    const childCtx = { ...c, launchStack: [...stack, app.id] };
    for (const depId of Array.isArray(app.requires) ? app.requires : []) {
      dependencies.push(...await ensureDependency(docker, app, depId, p, childCtx, h, onProgress));
    }
  }

  if (app.imagePolicy === 'local') {
    // Delivered as an archive: never pull. Missing means the operator has not run `docker load`.
    if (!(await imagePresent(docker, image))) {
      const repositories = allowedRepositories(app);
      const localImages = await listLocalImages(docker, repositories);
      throw new HttpError(404, 'image_not_loaded', `Image "${image}" is not loaded on this host. Load the delivered archive first: docker load -i <archive>.tar, then pick the tag in the launch dialog.`, { image, repository: repositories[0], repositories, localImages });
    }
  } else if (p.pull === 'always' || !(await imagePresent(docker, image))) {
    onProgress('pull', { image, status: 'pulling', id: null, current: null, total: null, message: `Pulling ${image}` });
    await pullImage(docker, image, (progress) => onProgress('pull', { image, ...progress }));
  }

  const conflict = await checkNameConflict(docker, name);
  if (conflict) {
    throw new HttpError(409, 'name_conflict', `A container named "${name}" already exists (${conflict.state})`, conflict);
  }

  onProgress('create', { name, image });
  let container;
  try {
    container = await docker.createContainer(createOptions);
  } catch (err) {
    if (err && err.statusCode === 409) {
      const raced = await checkNameConflict(docker, name).catch(() => null);
      throw new HttpError(409, 'name_conflict', `A container named "${name}" already exists`, raced || { id: null, name, state: 'unknown' });
    }
    if (err && err.statusCode === 404) {
      throw new HttpError(404, 'image_not_found', `Image "${image}" is not available on the Docker host`, { image });
    }
    throw toHttpError(err);
  }
  const id = container.id;

  onProgress('start', { id, name });
  try {
    await container.start();
  } catch (err) {
    if (!(err && err.statusCode === 304)) {
      const e = toHttpError(err);
      throw new HttpError(e.status, 'start_failed', `Container "${name}" was created but failed to start: ${e.message}`, { id, name });
    }
  }
  return { id, name, started: true, dependencies };
}
