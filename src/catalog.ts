/**
 * App catalog: loading, validation and small pure helpers shared with the
 * Docker launch module (template rendering, port range expansion, size parsing).
 *
 * See docs/DESIGN.md §6 for the App schema.
 */
import { readFile } from 'node:fs/promises';
import { HttpError } from './errors.js';
import { log } from './log.js';

/** Catalog app ids: lowercase, digits and dashes. */
export const APP_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
/** Docker container name rule (same as the daemon's). */
export const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;
/** Allowed `category` values. */
export const CATEGORIES = ['source', 'processing', 'output', 'monitoring', 'infrastructure', 'tools'];
/** Allowed `restartPolicy` values. */
export const RESTART_POLICIES = ['no', 'always', 'unless-stopped', 'on-failure'];
/** Allowed `ports[].protocol` values. */
export const PROTOCOLS = ['tcp', 'udp', 'sctp'];
/** Allowed `imagePolicy` values: pulled from a registry, or loaded locally with `docker load`. */
export const IMAGE_POLICIES = ['pull', 'local'];
/** Template variables that are always available in env/cmd/entrypoint/volumes[].name. */
export const BUILTIN_TEMPLATE_VARS = ['containerName', 'domainName', 'domainContainerPath'];
/** Docker named-volume name rule. */
export const VOLUME_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
/** `HostConfig.IpcMode` values accepted in a catalog entry. */
export const IPC_MODE_RE = /^(host|private|shareable|none|container:[a-zA-Z0-9][a-zA-Z0-9_.-]*)$/;

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TEMPLATE_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const SIZE_RE = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)(?:i?b)?\s*$/i;
const SIZE_MULTIPLIERS = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };

/**
 * Parse a human byte size such as `1g`, `512m`, `1gb`, `64MiB` or a plain
 * number of bytes into an integer byte count (binary multiples, like Docker).
 *
 * @param {string|number} value
 * @returns {number}
 * @throws {Error} when the value cannot be parsed
 */
export function parseByteSize(value) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`invalid byte size ${value} (expected a non-negative integer)`);
    }
    return value;
  }
  if (typeof value !== 'string') {
    throw new Error('invalid byte size (expected a number or a string like "1g")');
  }
  const m = SIZE_RE.exec(value);
  if (!m) {
    throw new Error(`invalid byte size "${value}" (expected e.g. "512m", "1g" or a byte count)`);
  }
  return Math.round(parseFloat(m[1]) * SIZE_MULTIPLIERS[m[2].toLowerCase()]);
}

/**
 * Repository part of an image reference: the reference without its `:tag` or
 * `@digest`. Registry ports (`localhost:5000/repo:1.0` → `localhost:5000/repo`) are kept.
 *
 * @param {string} ref
 * @returns {string}
 * @throws {TypeError} for an empty/non-string reference
 */
export function imageRepositoryOf(ref) {
  if (typeof ref !== 'string' || !ref.trim()) {
    throw new TypeError('imageRepositoryOf: reference must be a non-empty string');
  }
  let r = ref.trim();
  const at = r.indexOf('@');
  if (at !== -1) r = r.slice(0, at);
  const lastSlash = r.lastIndexOf('/');
  const lastColon = r.lastIndexOf(':');
  return lastColon > lastSlash ? r.slice(0, lastColon) : r;
}

/** Alias kept for callers written against the earlier name. */
export const imageRepositoryFromRef = imageRepositoryOf;

/**
 * Replace every `{{key}}` in `str` with `vars[key]`.
 *
 * @param {string} str template text
 * @param {Record<string, unknown>} [vars] values; `undefined`/`null` count as missing
 * @returns {string}
 * @throws {HttpError} 400 `unknown_template_variable` when a placeholder has no value
 */
export function renderTemplate(str, vars = {}) {
  if (typeof str !== 'string') {
    throw new TypeError('renderTemplate: template must be a string');
  }
  return str.replace(TEMPLATE_RE, (_match, key) => {
    const has = vars && Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== undefined && vars[key] !== null;
    if (!has) {
      throw new HttpError(400, 'unknown_template_variable', `Unknown template variable "{{${key}}}"`, { variable: key });
    }
    return String(vars[key]);
  });
}

/**
 * Collect the placeholder names used in a template string.
 * @param {string} str
 * @returns {string[]}
 */
function placeholdersIn(str) {
  const out = [];
  for (const m of String(str).matchAll(TEMPLATE_RE)) out.push(m[1]);
  return out;
}

/**
 * Expand `app.ports` (including `rangeEnd` ranges) into one entry per port.
 * `hostPort` is `null` for ports that are exposed but not published.
 *
 * @param {object} app catalog App
 * @returns {{ containerPort: number, hostPort: number|null, protocol: string }[]}
 */
export function expandPorts(app) {
  const out = [];
  for (const p of (app && Array.isArray(app.ports) ? app.ports : [])) {
    if (!p || !Number.isInteger(p.containerPort)) continue;
    const protocol = typeof p.protocol === 'string' && p.protocol ? p.protocol.toLowerCase() : 'tcp';
    const end = Number.isInteger(p.rangeEnd) && p.rangeEnd > p.containerPort ? p.rangeEnd : p.containerPort;
    for (let cp = p.containerPort; cp <= end; cp++) {
      const offset = cp - p.containerPort;
      out.push({
        containerPort: cp,
        hostPort: Number.isInteger(p.hostPort) ? p.hostPort + offset : null,
        protocol,
      });
    }
  }
  return out;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isPort = (v) => Number.isInteger(v) && v >= 1 && v <= 65535;
const isStringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');
const isAbsolutePath = (v) => typeof v === 'string' && v.startsWith('/') && v.length > 1;

/**
 * Validate one catalog entry against the App schema (DESIGN.md §6).
 *
 * @param {unknown} app
 * @returns {void}
 * @throws {Error} with a message naming the app id and the offending field
 */
export function validateApp(app) {
  if (!isPlainObject(app)) {
    throw new Error('Catalog entry must be a JSON object');
  }
  const label = typeof app.id === 'string' ? app.id : JSON.stringify(app.id);
  const fail = (field, why) => {
    throw new Error(`Catalog app "${label}": "${field}" ${why}`);
  };
  const optional = (field, pred, why) => {
    if (app[field] !== undefined && !pred(app[field])) fail(field, why);
  };
  const optionalBool = (field) => optional(field, (v) => typeof v === 'boolean', 'must be a boolean');

  if (!isNonEmptyString(app.id) || !APP_ID_RE.test(app.id)) {
    fail('id', 'must match ^[a-z0-9][a-z0-9-]*$');
  }
  if (!isNonEmptyString(app.name)) fail('name', 'must be a non-empty string');
  optional('description', (v) => typeof v === 'string', 'must be a string');
  if (!CATEGORIES.includes(app.category)) fail('category', `must be one of ${CATEGORIES.join(', ')}`);
  if (!isNonEmptyString(app.image) || /\s/.test(app.image)) fail('image', 'must be an image reference');
  optional('containerName', (v) => isNonEmptyString(v) && CONTAINER_NAME_RE.test(v), 'must match ^[a-zA-Z0-9][a-zA-Z0-9_.-]+$');
  optional('imagePolicy', (v) => IMAGE_POLICIES.includes(v), `must be one of ${IMAGE_POLICIES.join(', ')}`);
  const isRepository = (v) => isNonEmptyString(v) && !/\s/.test(v) && !/[:@]/.test(v.replace(/^[^/]+:\d+\//, ''));
  optional('imageRepository', isRepository, 'must be an image repository without tag or digest');
  optional('imageRepositories', (v) => Array.isArray(v) && v.length > 0 && v.every(isRepository), 'must be a non-empty array of image repositories without tag or digest');
  optional('ipcMode', (v) => isNonEmptyString(v) && IPC_MODE_RE.test(v), 'must be host, private, shareable, none or container:<name>');
  if (app.volumes !== undefined) {
    if (!Array.isArray(app.volumes)) fail('volumes', 'must be an array');
    app.volumes.forEach((v, i) => {
      const f = `volumes[${i}]`;
      if (!isPlainObject(v)) fail(f, 'must be an object');
      if (!isNonEmptyString(v.name)) fail(`${f}.name`, 'must be a non-empty volume name (may use {{placeholders}})');
      if (!isAbsolutePath(v.containerPath)) fail(`${f}.containerPath`, 'must be an absolute path');
      if (v.readOnly !== undefined && typeof v.readOnly !== 'boolean') fail(`${f}.readOnly`, 'must be a boolean');
    });
  }

  if (app.webUI !== undefined) {
    if (!isPlainObject(app.webUI)) fail('webUI', 'must be an object');
    if (!isPort(app.webUI.containerPort)) fail('webUI.containerPort', 'must be a port number (1-65535)');
    if (app.webUI.path !== undefined && !(typeof app.webUI.path === 'string' && app.webUI.path.startsWith('/'))) {
      fail('webUI.path', 'must start with "/"');
    }
    if (app.webUI.docsPath !== undefined && !(typeof app.webUI.docsPath === 'string' && app.webUI.docsPath.startsWith('/'))) {
      fail('webUI.docsPath', 'must start with "/"');
    }
  }

  if (app.ports !== undefined) {
    if (!Array.isArray(app.ports)) fail('ports', 'must be an array');
    app.ports.forEach((p, i) => {
      const f = `ports[${i}]`;
      if (!isPlainObject(p)) fail(f, 'must be an object');
      if (!isPort(p.containerPort)) fail(`${f}.containerPort`, 'must be a port number (1-65535)');
      if (p.hostPort !== undefined && p.hostPort !== null && !isPort(p.hostPort)) fail(`${f}.hostPort`, 'must be a port number (1-65535)');
      if (p.protocol !== undefined && !PROTOCOLS.includes(String(p.protocol).toLowerCase())) fail(`${f}.protocol`, `must be one of ${PROTOCOLS.join(', ')}`);
      if (p.rangeEnd !== undefined) {
        if (!isPort(p.rangeEnd) || p.rangeEnd < p.containerPort) fail(`${f}.rangeEnd`, 'must be a port number >= containerPort');
        if (isPort(p.hostPort) && p.hostPort + (p.rangeEnd - p.containerPort) > 65535) fail(`${f}.rangeEnd`, 'pushes the host port range past 65535');
      }
    });
  }

  if (app.domainMount !== undefined) {
    if (!isPlainObject(app.domainMount)) fail('domainMount', 'must be an object');
    if (!isAbsolutePath(app.domainMount.containerPath)) fail('domainMount.containerPath', 'must be an absolute path');
    if (app.domainMount.readOnly !== undefined && typeof app.domainMount.readOnly !== 'boolean') fail('domainMount.readOnly', 'must be a boolean');
    if (app.domainMount.envVar !== undefined && !(typeof app.domainMount.envVar === 'string' && IDENT_RE.test(app.domainMount.envVar))) {
      fail('domainMount.envVar', 'must be a valid environment variable name');
    }
  }

  if (app.env !== undefined) {
    if (!isPlainObject(app.env)) fail('env', 'must be an object of string values');
    for (const [k, v] of Object.entries(app.env)) {
      if (!IDENT_RE.test(k)) fail(`env.${k}`, 'is not a valid environment variable name');
      if (typeof v !== 'string') fail(`env.${k}`, 'must be a string');
    }
  }

  optional('extraHosts', isStringArray, 'must be an array of "host:ip" strings');
  optional('networkMode', isNonEmptyString, 'must be a non-empty string');
  if (app.shmSize !== undefined) {
    try {
      parseByteSize(app.shmSize);
    } catch (err) {
      fail('shmSize', err.message);
    }
  }
  optional('user', isNonEmptyString, 'must be a non-empty string like "1000:1000"');
  optional('cmd', isStringArray, 'must be an array of strings');
  optional('entrypoint', isStringArray, 'must be an array of strings');
  optionalBool('tty');
  optionalBool('stdinOpen');
  optionalBool('init');
  optionalBool('disabled');
  optional('restartPolicy', (v) => RESTART_POLICIES.includes(v), `must be one of ${RESTART_POLICIES.join(', ')}`);
  optional('notes', (v) => typeof v === 'string', 'must be a string');
  optional('source', (v) => typeof v === 'string', 'must be a string');

  const keyed = (field, extra) => {
    if (app[field] === undefined) return;
    if (!Array.isArray(app[field])) fail(field, 'must be an array');
    const seen = new Set();
    app[field].forEach((item, i) => {
      const f = `${field}[${i}]`;
      if (!isPlainObject(item)) fail(f, 'must be an object');
      if (!(typeof item.key === 'string' && IDENT_RE.test(item.key))) fail(`${f}.key`, 'must be an identifier ([A-Za-z_][A-Za-z0-9_]*)');
      if (seen.has(item.key)) fail(`${f}.key`, `duplicates "${item.key}"`);
      seen.add(item.key);
      if (item.label !== undefined && typeof item.label !== 'string') fail(`${f}.label`, 'must be a string');
      extra(item, f);
    });
  };
  keyed('hostPaths', (hp, f) => {
    if (!isAbsolutePath(hp.containerPath)) fail(`${f}.containerPath`, 'must be an absolute path');
    if (hp.readOnly !== undefined && typeof hp.readOnly !== 'boolean') fail(`${f}.readOnly`, 'must be a boolean');
    if (hp.required !== undefined && typeof hp.required !== 'boolean') fail(`${f}.required`, 'must be a boolean');
    if (hp.default !== undefined && typeof hp.default !== 'string') fail(`${f}.default`, 'must be a string');
  });
  keyed('params', (p, f) => {
    if (p.default !== undefined && typeof p.default !== 'string') fail(`${f}.default`, 'must be a string');
    if (p.help !== undefined && typeof p.help !== 'string') fail(`${f}.help`, 'must be a string');
  });

  if (app.requires !== undefined) {
    if (!isStringArray(app.requires)) fail('requires', 'must be an array of app ids');
    app.requires.forEach((dep, i) => {
      if (!APP_ID_RE.test(dep)) fail(`requires[${i}]`, 'is not a valid app id');
      if (dep === app.id) fail(`requires[${i}]`, 'must not reference the app itself');
    });
  }

  // Every template placeholder must be a built-in variable or backed by a declared param.
  const paramKeys = new Set([...BUILTIN_TEMPLATE_VARS, ...(app.params || []).map((p) => p.key)]);
  const checkTemplates = (field, strings) => {
    for (const s of strings) {
      for (const key of placeholdersIn(s)) {
        if (!paramKeys.has(key)) fail(field, `uses {{${key}}} but no param with key "${key}" is declared (built-ins: ${BUILTIN_TEMPLATE_VARS.join(', ')})`);
      }
    }
  };
  checkTemplates('env', Object.values(app.env || {}));
  checkTemplates('cmd', app.cmd || []);
  checkTemplates('entrypoint', app.entrypoint || []);
  checkTemplates('volumes', (app.volumes || []).map((v) => v.name));
}

/**
 * Return a defensive copy of a validated entry with defaults filled in so
 * consumers can rely on `ports`, `env`, `params`, `hostPaths`, `requires`,
 * `volumes`, `imagePolicy`, `imageRepository`, `containerName` and the boolean
 * flags being present.
 *
 * @param {object} app validated catalog entry
 * @returns {object}
 */
function normalizeApp(app) {
  const copy = structuredClone(app);
  copy.containerName = copy.containerName || copy.id;
  copy.description = copy.description || '';
  copy.ports = (copy.ports || []).map((p) => ({ ...p, protocol: (p.protocol || 'tcp').toLowerCase() }));
  copy.env = copy.env || {};
  copy.params = copy.params || [];
  copy.hostPaths = copy.hostPaths || [];
  copy.requires = copy.requires || [];
  copy.volumes = (copy.volumes || []).map((v) => ({ readOnly: false, ...v }));
  copy.imagePolicy = copy.imagePolicy || 'pull';
  copy.imageRepositories = Array.isArray(copy.imageRepositories) && copy.imageRepositories.length ? [...copy.imageRepositories] : null;
  copy.imageRepository = copy.imageRepository || (copy.imageRepositories ? copy.imageRepositories[0] : imageRepositoryOf(copy.image));
  if (!copy.imageRepositories) copy.imageRepositories = [copy.imageRepository];
  else if (!copy.imageRepositories.includes(copy.imageRepository)) copy.imageRepositories.unshift(copy.imageRepository);
  copy.tty = !!copy.tty;
  copy.stdinOpen = !!copy.stdinOpen;
  copy.init = !!copy.init;
  copy.disabled = !!copy.disabled;
  if (copy.webUI) copy.webUI = { path: '/', ...copy.webUI };
  if (copy.domainMount) copy.domainMount = { readOnly: false, ...copy.domainMount };
  return copy;
}

/**
 * Load and merge catalog files.
 *
 * Each file must contain a JSON array of App objects. Every entry is validated;
 * later files override earlier entries with the same `id`; entries with
 * `disabled: true` are dropped from the result. Unresolvable `requires` are
 * logged as warnings (they fail at launch time with a clear error).
 *
 * @param {string[]} paths absolute file paths, in precedence order (last wins)
 * @returns {Promise<object[]>} enabled apps, in first-seen order
 * @throws {Error} on unreadable files, invalid JSON or invalid entries
 */
export async function loadCatalog(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('loadCatalog: at least one catalog file path is required');
  }
  const byId = new Map();
  for (const file of paths) {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      throw new Error(`Cannot read catalog file ${file}: ${err.message}`);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error(`Catalog file ${file} is not valid JSON: ${err.message}`);
    }
    if (!Array.isArray(data)) {
      throw new Error(`Catalog file ${file} must contain a JSON array of apps`);
    }
    data.forEach((entry, index) => {
      try {
        validateApp(entry);
      } catch (err) {
        throw new Error(`${file} (entry ${index}): ${err.message}`);
      }
      if (byId.has(entry.id)) {
        log.debug(`catalog: ${file} overrides app "${entry.id}"`);
      }
      byId.set(entry.id, normalizeApp(entry));
    });
  }
  const apps = [...byId.values()].filter((app) => !app.disabled);
  const enabled = new Set(apps.map((a) => a.id));
  for (const app of apps) {
    for (const dep of app.requires) {
      if (!enabled.has(dep)) {
        log.warn(`catalog: app "${app.id}" requires "${dep}", which is not in the catalog or is disabled`);
      }
    }
  }
  return apps;
}

/**
 * Index apps by id.
 * @param {object[]} apps
 * @returns {Map<string, object>}
 */
export function indexById(apps) {
  const map = new Map();
  for (const app of apps || []) {
    if (app && typeof app.id === 'string') map.set(app.id, app);
  }
  return map;
}

/**
 * Find an app by id in a list or an `indexById` map.
 *
 * @param {object[]|Map<string, object>} apps
 * @param {string} id
 * @returns {object}
 * @throws {HttpError} 404 `app_not_found`
 */
export function resolveApp(apps, id) {
  const app = apps instanceof Map ? apps.get(id) : (apps || []).find((a) => a && a.id === id);
  if (!app) {
    throw new HttpError(404, 'app_not_found', `Unknown app "${id}"`, { id });
  }
  return app;
}
