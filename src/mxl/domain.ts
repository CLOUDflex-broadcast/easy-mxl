/**
 * MXL domain CRUD on the tmpfs root (default `/dev/shm/mxl`).
 *
 * A domain is `<root>/<name>/` holding `domain_def.json` (`{ id, label, description }`) and an
 * optional `options.json` (`{ "urn:x-mxl:option:history_duration/v1.0": <ns> }`). Containers
 * see it through a bind mount, so ownership matters: directories are chmod'ed to the
 * configured mode and chown'ed to the configured uid/gid when EASY MXL runs as root.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from '../errors.js';
import { log } from '../log.js';
import { FLOW_DIR_SUFFIX, UUID_RE, resolveFlowDir, scanFlows } from './flows.js';
import { findLocksForFile, readProcLocksOrNull } from './locks.js';

/** Allowed domain directory names: 1–64 chars, letters/digits/`.`/`_`/`-`, alnum first. */
export const DOMAIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** `options.json` key holding the ring-buffer depth in nanoseconds. */
export const HISTORY_KEY = 'urn:x-mxl:option:history_duration/v1.0';

/** `statfs().type` of a tmpfs filesystem (linux/magic.h). */
export const TMPFS_MAGIC = 0x01021994;

const DOMAIN_DEF_FILE = 'domain_def.json';
const OPTIONS_FILE = 'options.json';
const DEFAULT_PROC_ROOT = '/proc';
/** domain_def.json / options.json are tiny; refuse to slurp anything absurd. */
const MAX_JSON_BYTES = 1024 * 1024;
const S_ISVTX = 0o1000;

/**
 * @typedef {import('./locks.js').LockEntry} LockEntry
 * @typedef {import('./flows.js').Flow} Flow
 */

/**
 * @typedef {object} FsInfo
 * @property {'tmpfs'|'other'|'unknown'} fsType
 * @property {boolean} tmpfs
 * @property {number|null} totalBytes
 * @property {number|null} freeBytes
 * @property {number|null} availBytes
 */

/**
 * @typedef {object} Owner
 * @property {number} [uid]
 * @property {number} [gid]
 * @property {number|string} [mode] e.g. `0o775` or `"0775"`
 */

/**
 * @typedef {object} DomainListOptions
 * @property {boolean} [withFlows=false] include the full flow scan under `flows`
 * @property {LockEntry[]|null} [locks] pre-read `/proc/locks` entries (`null` = unreadable)
 * @property {string} [procRoot='/proc'] alternative /proc root
 * @property {number} [taiOffsetNs] TAI − UTC offset for the flow scan
 * @property {boolean} [resolveContainers] map writer PIDs to container ids (flow scan)
 */

/**
 * @typedef {object} Domain
 * @property {string} name
 * @property {string} path absolute directory
 * @property {true} exists
 * @property {{ id: string|null, label: string, description: string }|null} def
 * @property {string|null} defError
 * @property {number|null} historyDurationNs
 * @property {number|null} historyDurationMs
 * @property {object|null} optionsRaw parsed `options.json`
 * @property {string|null} optionsWarning set when the history option is present but not a JSON number (MXL ignores it)
 * @property {number} flowCount
 * @property {number} activeFlowCount
 * @property {Flow[]} [flows] only with `withFlows`
 * @property {FsInfo} fs
 * @property {{ uid: number, gid: number, mode: string }} owner mode as 4-digit octal string, e.g. `"0775"`
 * @property {string} mtime ISO mtime of the directory
 */

/**
 * Validate a domain name against {@link DOMAIN_NAME_RE}; `.`/`..` and path separators are rejected.
 *
 * @param {unknown} name
 * @throws {HttpError} 400 `invalid_domain_name`
 */
export function validateDomainName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new HttpError(400, 'invalid_domain_name', 'Domain name must be a non-empty string');
  }
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new HttpError(400, 'invalid_domain_name', `Invalid domain name ${JSON.stringify(name)}`);
  }
  if (!DOMAIN_NAME_RE.test(name)) {
    throw new HttpError(
      400,
      'invalid_domain_name',
      `Invalid domain name ${JSON.stringify(name)}: use 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit`,
    );
  }
}

/**
 * Absolute path of a domain directory (validates the name and guards against traversal).
 *
 * @param {string} root domain root, e.g. `/dev/shm/mxl`
 * @param {string} name
 * @returns {string}
 * @throws {HttpError} 400 `invalid_domain_name`
 */
export function domainPath(root, name) {
  validateDomainName(name);
  const base = path.resolve(String(root));
  const full = path.join(base, name);
  if (path.dirname(full) !== base || path.basename(full) !== name) {
    throw new HttpError(400, 'invalid_domain_name', `Invalid domain name ${JSON.stringify(name)}`);
  }
  return full;
}

/**
 * Filesystem information for a path via `fs.statfs`. `fsType` is `'unknown'` when statfs is
 * unavailable or fails (missing path, unsupported platform).
 *
 * @param {string} target
 * @returns {Promise<FsInfo>}
 */
export async function fsInfo(target) {
  const unknown = { fsType: 'unknown', tmpfs: false, totalBytes: null, freeBytes: null, availBytes: null };
  if (typeof fs.statfs !== 'function') return unknown;
  try {
    const s = await fs.statfs(target);
    const bsize = Number(s.bsize);
    const tmpfs = Number(s.type) === TMPFS_MAGIC;
    return {
      fsType: tmpfs ? 'tmpfs' : 'other',
      tmpfs,
      totalBytes: Number(s.blocks) * bsize,
      freeBytes: Number(s.bfree) * bsize,
      availBytes: Number(s.bavail) * bsize,
    };
  } catch {
    return unknown;
  }
}

/**
 * `mkdir -p` the domain root and apply ownership/mode best effort (EPERM is ignored, chown
 * only when running as root). A sticky world-writable directory such as `/dev/shm` or `/tmp`
 * used directly as root is left untouched.
 *
 * @param {string} root
 * @param {Owner} [owner]
 * @returns {Promise<void>}
 */
export async function ensureRoot(root, owner = {}) {
  const dir = path.resolve(String(root));
  await fs.mkdir(dir, { recursive: true });
  const st = await fs.stat(dir);
  if (!st.isDirectory()) {
    throw new HttpError(500, 'domain_root_invalid', `${dir} exists but is not a directory`);
  }
  if (st.mode & S_ISVTX) return;
  await applyOwner(dir, owner);
}

/**
 * List every sub-directory of the root as a domain. Directories without `domain_def.json`
 * are included with `def: null` so stray directories stay visible. A missing root yields `[]`.
 *
 * @param {string} root
 * @param {DomainListOptions} [opts]
 * @returns {Promise<Domain[]>}
 */
export async function listDomains(root, opts = {}) {
  const base = path.resolve(String(root));
  let entries;
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }
  const names = entries
    .filter((entry) => entry.isDirectory() && DOMAIN_NAME_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const shared = await sharedScanOptions(opts);
  const domains = await Promise.all(
    names.map(async (name) => {
      try {
        return await buildDomain(base, name, opts, shared);
      } catch (err) {
        if (isMissing(err)) return null; // removed while listing
        throw err;
      }
    }),
  );
  return domains.filter(Boolean);
}

/**
 * Read one domain.
 *
 * @param {string} root
 * @param {string} name
 * @param {DomainListOptions} [opts]
 * @returns {Promise<Domain>}
 * @throws {HttpError} 400 `invalid_domain_name`, 404 `domain_not_found`
 */
export async function getDomain(root, name, opts = {}) {
  domainPath(root, name);
  try {
    return await buildDomain(path.resolve(String(root)), name, opts, await sharedScanOptions(opts));
  } catch (err) {
    if (isMissing(err)) throw new HttpError(404, 'domain_not_found', `Domain "${name}" not found`);
    throw err;
  }
}

/**
 * Create a domain directory with `domain_def.json` (and `options.json` when a history
 * duration is given). Files are written with 2-space indentation and a trailing newline.
 *
 * @param {string} root
 * @param {{ name: string, label?: string, description?: string, id?: string, historyDurationMs?: number }} input
 * @param {Owner} [owner] `{ uid, gid, mode }` — chmod always (best effort), chown only as root
 * @returns {Promise<Domain>}
 * @throws {HttpError} 400 on invalid input, 409 `domain_exists` when the directory exists
 */
export async function createDomain(root, input, owner = {}) {
  if (!isObject(input)) throw new HttpError(400, 'validation_error', 'Domain definition must be an object');
  const name = input.name;
  const dir = domainPath(root, name);
  const label = optionalString(input.label, 'label') ?? name;
  const description = optionalString(input.description, 'description') ?? '';
  let id = randomUUID();
  if (input.id !== undefined && input.id !== null && input.id !== '') {
    if (typeof input.id !== 'string' || !UUID_RE.test(input.id)) {
      throw new HttpError(400, 'validation_error', 'id must be a UUID');
    }
    id = input.id.toLowerCase();
  }
  const historyNs = input.historyDurationMs === undefined || input.historyDurationMs === null
    ? null
    : historyMsToNs(input.historyDurationMs);

  await ensureRoot(root, owner);
  try {
    await fs.mkdir(dir);
  } catch (err) {
    if (err.code === 'EEXIST') throw new HttpError(409, 'domain_exists', `Domain "${name}" already exists`);
    throw err;
  }
  try {
    await writeJsonFile(path.join(dir, DOMAIN_DEF_FILE), { id, label, description }, owner);
    if (historyNs !== null) {
      await writeJsonFile(path.join(dir, OPTIONS_FILE), { [HISTORY_KEY]: historyNs }, owner);
    }
    await applyOwner(dir, owner);
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  return getDomain(root, name);
}

/**
 * Regenerate `domain_def.json` for a directory that lacks one or carries an unreadable one,
 * so the DMF-MXL apps discover it again. A valid definition is only replaced with `force`.
 *
 * @param {string} root domain root
 * @param {string} name domain directory name
 * @param {{ label?: string, description?: string, id?: string }} [input] fields for the new file; `id` defaults to a fresh UUID, `label` to the name
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<Domain>}
 * @throws {HttpError} 404 `domain_not_found`, 409 `domain_def_exists` when a valid file exists and `force` is not set, 400 on invalid input
 */
export async function repairDomainDef(root, name, input = {}, opts = {}) {
  const dir = domainPath(root, name);
  const st = await statDomainDir(dir, name);
  const fields = isObject(input) ? input : {};
  const file = path.join(dir, DOMAIN_DEF_FILE);
  const current = await readJsonFile(file);
  const valid = isObject(current.value) && typeof current.value.id === 'string' && UUID_RE.test(current.value.id);
  if (valid && !opts.force) {
    throw new HttpError(409, 'domain_def_exists', `Domain "${name}" already has a valid ${DOMAIN_DEF_FILE} (pass force to regenerate it)`, { id: current.value.id });
  }
  const label = optionalString(fields.label, 'label') ?? (isObject(current.value) && typeof current.value.label === 'string' && current.value.label ? current.value.label : name);
  const description = optionalString(fields.description, 'description') ?? (isObject(current.value) && typeof current.value.description === 'string' ? current.value.description : '');
  let id = randomUUID();
  if (fields.id !== undefined && fields.id !== null && fields.id !== '') {
    if (typeof fields.id !== 'string' || !UUID_RE.test(fields.id)) throw new HttpError(400, 'validation_error', 'id must be a UUID');
    id = fields.id.toLowerCase();
  }
  await writeJsonFile(file, { id, label, description }, { uid: st.uid, gid: st.gid });
  log.info(`regenerated ${DOMAIN_DEF_FILE} for domain ${name}`, { id, label, replaced: valid });
  return getDomain(root, name);
}

/**
 * Set or remove the history duration in `options.json`. `null` removes the key (and the file
 * when nothing else is left in it, so MXL falls back to its 200 ms default).
 *
 * @param {string} root
 * @param {string} name
 * @param {{ historyDurationMs: number|null }} patch
 * @returns {Promise<Domain>}
 * @throws {HttpError} 400 on invalid input, 404 `domain_not_found`
 */
export async function updateDomainOptions(root, name, patch) {
  const dir = domainPath(root, name);
  const st = await statDomainDir(dir, name);
  if (!isObject(patch) || !('historyDurationMs' in patch)) {
    throw new HttpError(400, 'validation_error', 'historyDurationMs is required (number > 0 or null)');
  }
  const file = path.join(dir, OPTIONS_FILE);
  const current = await readJsonFile(file);
  const options = isObject(current.value) ? { ...current.value } : {};
  if (patch.historyDurationMs === null) delete options[HISTORY_KEY];
  else options[HISTORY_KEY] = historyMsToNs(patch.historyDurationMs);

  if (Object.keys(options).length === 0) {
    await fs.rm(file, { force: true });
  } else {
    await writeJsonFile(file, options, { uid: st.uid, gid: st.gid });
  }
  return getDomain(root, name);
}

/**
 * Remove a domain directory recursively.
 *
 * @param {string} root
 * @param {string} name
 * @param {{ force?: boolean, locks?: LockEntry[]|null, procRoot?: string }} [opts]
 *   `locks`/`procRoot` let callers reuse an already-read `/proc/locks`
 * @returns {Promise<void>}
 * @throws {HttpError} 404 `domain_not_found`; 409 `domain_active` when flows are locked and `!force`
 */
export async function deleteDomain(root, name, opts = {}) {
  const dir = domainPath(root, name);
  await statDomainDir(dir, name);
  if (!opts.force) {
    const locks = await resolveLocks(opts);
    if (locks === null) log.warn('cannot read /proc/locks; deleting domain without active-flow check', { domain: name });
    const { activeFlowCount } = await countFlows(dir, locks);
    if (activeFlowCount > 0) {
      throw new HttpError(
        409,
        'domain_active',
        `Domain "${name}" has ${activeFlowCount} active flow(s); stop the writers first or force the deletion`,
        { activeFlowCount },
      );
    }
  }
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Remove one flow directory from a domain.
 *
 * @param {string} root
 * @param {string} name
 * @param {string} flowId
 * @param {{ force?: boolean, locks?: LockEntry[]|null, procRoot?: string }} [opts]
 * @returns {Promise<void>}
 * @throws {HttpError} 400 `invalid_flow_id`; 404 `domain_not_found` / `flow_not_found`;
 *   409 `flow_active` when a writer holds the lock and `!force`
 */
export async function deleteFlow(root, name, flowId, opts = {}) {
  const dir = domainPath(root, name);
  await statDomainDir(dir, name);
  if (typeof flowId !== 'string' || !UUID_RE.test(flowId)) {
    throw new HttpError(400, 'invalid_flow_id', `Invalid flow id "${String(flowId)}": expected a UUID`);
  }
  const id = flowId.toLowerCase();
  const flowDir = await resolveFlowDir(dir, id);
  if (flowDir === null) throw new HttpError(404, 'flow_not_found', `Flow ${id} not found in domain "${name}"`);

  if (!opts.force) {
    const locks = await resolveLocks(opts);
    if (locks === null) log.warn('cannot read /proc/locks; deleting flow without active check', { domain: name, flow: id });
    const held = await locksOnData(flowDir, locks);
    if (held.length > 0) {
      const holder = held.find((lock) => lock.pid > 0);
      throw new HttpError(
        409,
        'flow_active',
        `Flow ${id} is being written (pid ${holder ? holder.pid : 'unknown'}); stop the writer first or force the deletion`,
        { writerPid: holder ? holder.pid : null },
      );
    }
  }
  await fs.rm(flowDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------------
// internals

/**
 * @param {string} base resolved root
 * @param {string} name
 * @param {DomainListOptions} opts
 * @param {Awaited<ReturnType<typeof sharedScanOptions>>} shared
 * @returns {Promise<Domain>}
 */
async function buildDomain(base, name, opts, shared) {
  const dir = path.join(base, name);
  const st = await fs.stat(dir);
  if (!st.isDirectory()) throw Object.assign(new Error(`${dir} is not a directory`), { code: 'ENOTDIR' });

  const [defResult, optionsResult, fsi] = await Promise.all([
    readJsonFile(path.join(dir, DOMAIN_DEF_FILE)),
    readJsonFile(path.join(dir, OPTIONS_FILE)),
    fsInfo(dir),
  ]);
  if (optionsResult.error) log.debug('ignoring unreadable options.json', { domain: name, error: optionsResult.error });

  const domain = {
    name,
    path: dir,
    exists: true,
    def: defResult.value
      ? {
          id: typeof defResult.value.id === 'string' ? defResult.value.id : null,
          label: typeof defResult.value.label === 'string' ? defResult.value.label : '',
          description: typeof defResult.value.description === 'string' ? defResult.value.description : '',
        }
      : null,
    defError: defResult.error ?? (defResult.value ? null : `${DOMAIN_DEF_FILE} missing`),
    historyDurationNs: null,
    historyDurationMs: null,
    optionsRaw: optionsResult.value,
    optionsWarning: null,
    flowCount: 0,
    activeFlowCount: 0,
    fs: fsi,
    owner: { uid: st.uid, gid: st.gid, mode: (st.mode & 0o7777).toString(8).padStart(4, '0') },
    mtime: st.mtime.toISOString(),
  };
  const history = historyFromOptions(optionsResult.value);
  if (history.value !== null) {
    domain.historyDurationNs = history.value;
    domain.historyDurationMs = history.value / 1e6;
  }
  domain.optionsWarning = history.warning;

  if (opts && opts.withFlows) {
    const flows = await scanFlows(dir, shared);
    domain.flows = flows;
    domain.flowCount = flows.length;
    domain.activeFlowCount = flows.filter((flow) => flow.active === true).length;
  } else {
    const counts = await countFlows(dir, shared.locks);
    domain.flowCount = counts.flowCount;
    domain.activeFlowCount = counts.activeFlowCount;
  }
  return domain;
}

/**
 * Options forwarded to {@link scanFlows}, with `/proc/locks` read exactly once.
 *
 * @param {DomainListOptions} opts
 * @returns {Promise<{ locks: LockEntry[]|null, procRoot?: string, taiOffsetNs?: number, resolveContainers?: boolean }>}
 */
async function sharedScanOptions(opts) {
  const o = isObject(opts) ? opts : {};
  const shared = { locks: await resolveLocks(o) };
  if (typeof o.procRoot === 'string') shared.procRoot = o.procRoot;
  if (typeof o.taiOffsetNs === 'number') shared.taiOffsetNs = o.taiOffsetNs;
  if (typeof o.resolveContainers === 'boolean') shared.resolveContainers = o.resolveContainers;
  return shared;
}

/**
 * @param {{ locks?: LockEntry[]|null, procRoot?: string }} opts
 * @returns {Promise<LockEntry[]|null>}
 */
async function resolveLocks(opts) {
  if (opts.locks !== undefined) return Array.isArray(opts.locks) ? opts.locks : null;
  const procRoot = typeof opts.procRoot === 'string' && opts.procRoot ? opts.procRoot : DEFAULT_PROC_ROOT;
  return readProcLocksOrNull(path.join(procRoot, 'locks'));
}

/**
 * Cheap flow census: count `<uuid>.mxl-flow` directories and, when locks are known, how many
 * have their `data` file flocked.
 *
 * @param {string} dir domain directory
 * @param {LockEntry[]|null} locks
 * @returns {Promise<{ flowCount: number, activeFlowCount: number }>}
 */
async function countFlows(dir, locks) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { flowCount: 0, activeFlowCount: 0 };
  }
  const flowDirs = entries.filter((entry) => entry.isDirectory() && isFlowDirName(entry.name));
  if (!locks || locks.length === 0) return { flowCount: flowDirs.length, activeFlowCount: 0 };
  const flags = await Promise.all(
    flowDirs.map(async (entry) => (await locksOnData(path.join(dir, entry.name), locks)).length > 0),
  );
  return { flowCount: flowDirs.length, activeFlowCount: flags.filter(Boolean).length };
}

/**
 * FLOCK entries held on `<flowDir>/data`; `[]` when the file is missing or locks are unknown.
 *
 * @param {string} flowDir
 * @param {LockEntry[]|null} locks
 * @returns {Promise<LockEntry[]>}
 */
async function locksOnData(flowDir, locks) {
  if (!locks || locks.length === 0) return [];
  try {
    return findLocksForFile(locks, await fs.stat(path.join(flowDir, 'data')));
  } catch {
    return [];
  }
}

/**
 * @param {string} name directory entry name
 * @returns {boolean}
 */
function isFlowDirName(name) {
  return name.endsWith(FLOW_DIR_SUFFIX) && UUID_RE.test(name.slice(0, -FLOW_DIR_SUFFIX.length));
}

/**
 * Stat a domain directory, translating a missing directory into 404.
 *
 * @param {string} dir
 * @param {string} name
 * @returns {Promise<import('node:fs').Stats>}
 */
async function statDomainDir(dir, name) {
  try {
    const st = await fs.stat(dir);
    if (!st.isDirectory()) throw new HttpError(404, 'domain_not_found', `Domain "${name}" not found`);
    return st;
  } catch (err) {
    if (isMissing(err)) throw new HttpError(404, 'domain_not_found', `Domain "${name}" not found`);
    throw err;
  }
}

/**
 * @param {string} file
 * @returns {Promise<{ value: object|null, error: string|null }>} missing file → `{ null, null }`
 */
async function readJsonFile(file) {
  const base = path.basename(file);
  let text;
  try {
    const st = await fs.stat(file);
    if (st.size > MAX_JSON_BYTES) return { value: null, error: `${base} is too large (${st.size} bytes)` };
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { value: null, error: null };
    return { value: null, error: `cannot read ${base}: ${err.message}` };
  }
  try {
    const value = JSON.parse(text);
    if (!isObject(value)) return { value: null, error: `${base} is not a JSON object` };
    return { value, error: null };
  } catch (err) {
    return { value: null, error: `invalid ${base}: ${err.message}` };
  }
}

/**
 * Write JSON (2-space indent, trailing newline) atomically via rename; chown as root, best effort.
 *
 * @param {string} file
 * @param {object} value
 * @param {Owner} owner
 * @returns {Promise<void>}
 */
async function writeJsonFile(file, value, owner) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
    await applyOwner(tmp, owner, { mode: false });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * chmod to `owner.mode` and (as root) chown to `owner.uid:owner.gid`, ignoring permission errors.
 *
 * @param {string} target
 * @param {Owner|undefined} owner
 * @param {{ mode?: boolean }} [flags] `mode: false` skips chmod
 * @returns {Promise<void>}
 */
async function applyOwner(target, owner, flags = {}) {
  if (!isObject(owner)) return;
  if (isRoot() && Number.isInteger(owner.uid) && Number.isInteger(owner.gid)) {
    await bestEffort(fs.chown(target, owner.uid, owner.gid), 'chown', target);
  }
  if (flags.mode !== false) {
    const mode = parseMode(owner.mode);
    if (mode !== null) await bestEffort(fs.chmod(target, mode), 'chmod', target);
  }
}

/**
 * @param {Promise<void>} operation
 * @param {string} what
 * @param {string} target
 * @returns {Promise<void>}
 */
async function bestEffort(operation, what, target) {
  try {
    await operation;
  } catch (err) {
    log.debug(`${what} failed (ignored)`, { target, error: err && err.message });
  }
}

/**
 * @returns {boolean}
 */
function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/**
 * @param {unknown} mode number (`0o775`) or octal string (`"0775"`, `"775"`)
 * @returns {number|null}
 */
function parseMode(mode) {
  if (typeof mode === 'number' && Number.isInteger(mode) && mode >= 0) return mode & 0o7777;
  if (typeof mode === 'string' && /^[0-7]{3,4}$/.test(mode.trim())) return Number.parseInt(mode.trim(), 8);
  return null;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string|undefined}
 */
function optionalString(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, 'validation_error', `${field} must be a string`);
  return value;
}

/**
 * @param {unknown} ms
 * @returns {number} nanoseconds
 * @throws {HttpError} 400 when not a positive finite number
 */
function historyMsToNs(ms) {
  const value = typeof ms === 'string' && ms.trim() !== '' ? Number(ms) : ms;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new HttpError(400, 'validation_error', 'historyDurationMs must be a number greater than 0');
  }
  return Math.round(value * 1e6);
}

/**
 * @param {object|null} options parsed options.json
 * @returns {number|null} history duration in ns
 */
function historyFromOptions(options) {
  if (!isObject(options)) return { value: null, warning: null };
  const raw = options[HISTORY_KEY];
  if (raw === undefined) return { value: null, warning: null };
  // The SDK only honours a JSON number (picojson is<double>); strings and other types are ignored.
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return { value: raw, warning: null };
  return {
    value: null,
    warning: `${HISTORY_KEY} must be a positive JSON number (got ${JSON.stringify(raw)}); MXL ignores it and uses the 200 ms default`,
  };
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isMissing(err) {
  if (!err || typeof err !== 'object') return false;
  const e = /** @type {any} */ (err);
  return e.code === 'ENOENT' || e.code === 'ENOTDIR' || (e instanceof HttpError && e.status === 404);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
