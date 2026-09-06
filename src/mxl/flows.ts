/**
 * Flow discovery inside an MXL domain directory.
 *
 * Every `<uuid>.mxl-flow/` sub-directory is a flow: `flow_def.json` (NMOS IS-04 Flow),
 * `data` (the `mxlFlowInfo` header), `grains/` (discrete) or `channels` (continuous).
 * A flow is *active* when a writer holds a shared flock on `data`, which we observe in
 * `/proc/locks` (read once per scan) and map back to a PID and Docker container id.
 *
 * Nothing in here throws for a broken flow: read/parse problems are recorded in the
 * `defError` / `headerError` fields and the flow is reported as `stale`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from '../errors.js';
import { log } from '../log.js';
import { FLOW_INFO_SIZE, indexToTimestamp, parseFlowInfo, timestampToIndex } from './flowinfo.js';
import { containerIdForPid, findLocksForFile, readProcLocksOrNull } from './locks.js';
import { getTaiOffsetNs, nowTaiNs } from './time.js';

/** Directory name suffix of a flow inside a domain. */
export const FLOW_DIR_SUFFIX = '.mxl-flow';

/** RFC 4122 textual UUID (case-insensitive). */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FLOW_DIR_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.mxl-flow$/i;
const GROUP_HINT_TAG = 'urn:x-nmos:tag:grouphint/v1.0';
const FORMAT_URN_RE = /^urn:x-nmos:format:([a-z0-9_-]+)$/i;
const KNOWN_FORMATS = new Set(['video', 'audio', 'data']);
const DEFAULT_PROC_ROOT = '/proc';
/** flow_def.json is a few hundred bytes; refuse to slurp anything absurd. */
const MAX_FLOW_DEF_BYTES = 1024 * 1024;
/** Largest |ms| that `new Date()` accepts. */
const MAX_DATE_MS = 8.64e15;

/**
 * @typedef {import('./locks.js').LockEntry} LockEntry
 * @typedef {import('./flowinfo.js').FlowHeader} FlowHeader
 */

/**
 * @typedef {object} ScanOptions
 * @property {LockEntry[]|null} [locks] pre-read `/proc/locks` entries; `null` means "unreadable"
 *   (every flow gets `active: null`); omitted → read `<procRoot>/locks` once
 * @property {number} [taiOffsetNs] TAI − UTC offset in ns; omitted → {@link getTaiOffsetNs}
 * @property {boolean} [resolveContainers=true] map writer PIDs to container ids via `<procRoot>/<pid>/cgroup`
 * @property {string} [procRoot='/proc'] alternative /proc root (tests, containerised deployments)
 * @property {bigint|string|number} [nowTaiNs] fixed "now" in TAI ns instead of the wall clock (tests)
 * @property {Map<number, Promise<string|null>>} [containerIds] shared PID → container id cache
 */

/**
 * @typedef {object} Flow
 * @property {string} id lowercase UUID
 * @property {string} dir absolute flow directory
 * @property {string} label
 * @property {string} description
 * @property {string} groupHint raw `<Group>:<Role>` tag
 * @property {string} group
 * @property {string} role
 * @property {'video'|'audio'|'data'|'unknown'} format from `flow_def.format`, falling back to the header
 * @property {string} mediaType
 * @property {string} summary human summary of the flow definition
 * @property {object|null} def parsed `flow_def.json`
 * @property {string|null} defError
 * @property {FlowHeader|null} header
 * @property {string|null} headerError
 * @property {boolean|null} active `null` when `/proc/locks` is unreadable
 * @property {number|null} writerPid
 * @property {string|null} writerContainerId full 64-hex container id
 * @property {'active'|'inactive'|'stale'} status
 * @property {number|null} grainFiles entries in `grains/` for discrete flows
 * @property {number} sizeBytes regular file bytes in the flow dir (one level) plus `grains/`
 * @property {number|null} lastWriteAgeMs `(nowTai − lastWriteTime) / 1e6`; `null` for continuous flows
 * @property {number|null} latencyGrains `timestampToIndex(rate, nowTai) − headIndex`
 * @property {string|null} headTimeIso UTC ISO time of the head grain (TAI offset removed)
 * @property {string} mtime ISO mtime of the flow directory
 */

/**
 * Split the NMOS group hint tag (`tags["urn:x-nmos:tag:grouphint/v1.0"][0]`) at its FIRST `:`.
 * Every field is `""` when the tag is absent.
 *
 * @param {object|null|undefined} flowDef parsed flow_def.json
 * @returns {{ groupHint: string, group: string, role: string }}
 */
export function parseGroupHint(flowDef) {
  const tags = isObject(flowDef) ? flowDef.tags : null;
  const values = isObject(tags) ? tags[GROUP_HINT_TAG] : null;
  let hint = '';
  if (Array.isArray(values) && typeof values[0] === 'string') hint = values[0].trim();
  else if (typeof values === 'string') hint = values.trim();
  if (!hint) return { groupHint: '', group: '', role: '' };
  const i = hint.indexOf(':');
  if (i < 0) return { groupHint: hint, group: hint, role: '' };
  return { groupHint: hint, group: hint.slice(0, i), role: hint.slice(i + 1) };
}

/**
 * One-line summary of a flow definition, e.g. `"1920x1080p 30000/1001 video/v210"`,
 * `"2 ch @ 48000 Hz audio/float32"`, `"video/smpte291 30000/1001"`. `""` when nothing is known.
 *
 * @param {object|null|undefined} flowDef parsed flow_def.json
 * @returns {string}
 */
export function summarizeFlowDef(flowDef) {
  if (!isObject(flowDef)) return '';
  const format = formatFromDef(flowDef);
  const mediaType = stringOrEmpty(flowDef.media_type);
  const parts = [];
  if (format === 'video') {
    const geometry = geometryText(flowDef);
    const rate = rationalText(flowDef.grain_rate);
    if (geometry) parts.push(geometry);
    if (rate) parts.push(rate);
    if (mediaType) parts.push(mediaType);
  } else if (format === 'audio') {
    const channels = Number(flowDef.channel_count);
    const rate = sampleRateText(flowDef.sample_rate);
    if (Number.isInteger(channels) && channels > 0) parts.push(`${channels} ch`);
    if (rate) parts.push(`@ ${rate} Hz`);
    if (mediaType) parts.push(mediaType);
  } else if (format === 'data') {
    const rate = rationalText(flowDef.grain_rate);
    if (mediaType) parts.push(mediaType);
    if (rate) parts.push(rate);
  } else if (mediaType) {
    parts.push(mediaType);
  }
  return parts.join(' ');
}

/**
 * Read a single flow.
 *
 * @param {string} domainPath absolute domain directory
 * @param {string} flowId flow UUID (any case)
 * @param {ScanOptions} [ctx] shared scan context; missing pieces (locks, TAI offset) are fetched
 * @returns {Promise<Flow>}
 * @throws {HttpError} 400 `invalid_flow_id`, 404 `flow_not_found`
 */
export async function readFlow(domainPath, flowId, ctx = {}) {
  if (typeof flowId !== 'string' || !UUID_RE.test(flowId)) {
    throw new HttpError(400, 'invalid_flow_id', `Invalid flow id "${String(flowId)}": expected a UUID`);
  }
  const id = flowId.toLowerCase();
  const dir = await resolveFlowDir(domainPath, id);
  if (dir === null) throw new HttpError(404, 'flow_not_found', `Flow ${id} not found in ${domainPath}`);
  let dirStat;
  try {
    dirStat = await fs.stat(dir);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      throw new HttpError(404, 'flow_not_found', `Flow ${id} not found in ${domainPath}`);
    }
    throw err;
  }
  const scan = await prepareScan(ctx);
  const raw = await collectFlow(dir, id, dirStat, scan);
  const timing = await resolveTiming(scan, [raw]);
  return finishFlow(raw, timing);
}

/**
 * List every flow of a domain. `/proc/locks` is read once, each `data` file is stat'ed
 * once and lock entries are matched by (major, minor, inode). Sorted by group, role, label.
 *
 * @param {string} domainPath absolute domain directory
 * @param {ScanOptions} [opts]
 * @returns {Promise<Flow[]>}
 * @throws {HttpError} 404 `domain_not_found` when the directory does not exist
 */
export async function scanFlows(domainPath, opts = {}) {
  const dir = path.resolve(String(domainPath));
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      throw new HttpError(404, 'domain_not_found', `Domain directory ${dir} does not exist`);
    }
    throw err;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const m = FLOW_DIR_RE.exec(entry.name);
    if (m) candidates.push({ id: m[1].toLowerCase(), dir: path.join(dir, entry.name) });
  }
  const scan = await prepareScan(opts);
  const raws = (await Promise.all(candidates.map((c) => collectFlowSafe(c.dir, c.id, scan)))).filter(Boolean);
  const timing = await resolveTiming(scan, raws);
  return raws.map((raw) => finishFlow(raw, timing)).sort(compareFlows);
}

/**
 * Locate a flow's directory inside a domain. The lowercase `<uuid>.mxl-flow` path is tried
 * first; a directory whose name spells the UUID in upper case is found by listing the domain.
 *
 * @param {string} domainPath absolute domain directory
 * @param {string} flowId flow UUID (any case, assumed valid)
 * @returns {Promise<string|null>} absolute flow directory, or `null` when there is none
 */
export async function resolveFlowDir(domainPath, flowId) {
  const id = String(flowId).toLowerCase();
  const base = path.resolve(String(domainPath));
  const direct = path.join(base, id + FLOW_DIR_SUFFIX);
  try {
    if ((await fs.stat(direct)).isDirectory()) return direct;
  } catch {
    // fall through to the case-insensitive lookup
  }
  let entries;
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const m = FLOW_DIR_RE.exec(entry.name);
    if (m && m[1].toLowerCase() === id) return path.join(base, entry.name);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// scan context

/**
 * @param {ScanOptions} opts
 * @returns {Promise<{ locks: LockEntry[]|null, procRoot: string, resolveContainers: boolean,
 *   containerIds: Map<number, Promise<string|null>>, taiOffsetNs: number|undefined, nowTaiNs: bigint|null }>}
 */
async function prepareScan(opts) {
  const o = isObject(opts) ? opts : {};
  const procRoot = typeof o.procRoot === 'string' && o.procRoot ? o.procRoot : DEFAULT_PROC_ROOT;
  let locks;
  if (o.locks === undefined) locks = await readProcLocksOrNull(path.join(procRoot, 'locks'));
  else locks = Array.isArray(o.locks) ? o.locks : null;
  return {
    locks,
    procRoot,
    resolveContainers: o.resolveContainers !== false,
    containerIds: o.containerIds instanceof Map ? o.containerIds : new Map(),
    taiOffsetNs: typeof o.taiOffsetNs === 'number' && Number.isFinite(o.taiOffsetNs) ? o.taiOffsetNs : undefined,
    nowTaiNs: o.nowTaiNs === undefined || o.nowTaiNs === null ? null : toBigIntOrNull(o.nowTaiNs),
  };
}

/**
 * Determine the TAI offset and "now" for a scan. When the python probe is unavailable the
 * newest `lastWriteTime` of an actively written discrete flow is offered as an estimate hint.
 *
 * @param {Awaited<ReturnType<typeof prepareScan>>} scan
 * @param {RawFlow[]} raws
 * @returns {Promise<{ offsetNs: number, nowTai: bigint }>}
 */
async function resolveTiming(scan, raws) {
  let offsetNs = scan.taiOffsetNs;
  if (offsetNs === undefined) {
    try {
      offsetNs = await getTaiOffsetNs({ activeWriteTimeNs: newestActiveWriteTime(raws) });
    } catch (err) {
      log.warn('TAI offset lookup failed, assuming TAI == UTC', { error: err && err.message });
      offsetNs = 0;
    }
  }
  const nowTai = scan.nowTaiNs ?? nowTaiNs(offsetNs);
  return { offsetNs, nowTai };
}

/**
 * @param {RawFlow[]} raws
 * @returns {bigint|null}
 */
function newestActiveWriteTime(raws) {
  let newest = null;
  for (const raw of raws) {
    if (raw.active !== true || !raw.header || !raw.header.discrete) continue;
    const t = toBigIntOrNull(raw.header.lastWriteTime);
    if (t !== null && t > 0n && (newest === null || t > newest)) newest = t;
  }
  return newest;
}

// ---------------------------------------------------------------------------------------------
// per-flow collection (I/O)

/**
 * @typedef {object} RawFlow everything read from disk, before time-derived fields
 * @property {string} id
 * @property {string} dir
 * @property {object|null} def
 * @property {string|null} defError
 * @property {FlowHeader|null} header
 * @property {string|null} headerError
 * @property {'video'|'audio'|'data'|'unknown'} format
 * @property {string} label
 * @property {string} description
 * @property {string} mediaType
 * @property {string} groupHint
 * @property {string} group
 * @property {string} role
 * @property {string} summary
 * @property {boolean|null} active
 * @property {number|null} writerPid
 * @property {string|null} writerContainerId
 * @property {number|null} grainFiles
 * @property {number} sizeBytes
 * @property {string} mtime
 */

/**
 * Collect a flow, never rejecting: a directory that vanished mid-scan yields `null`, any
 * other unexpected failure yields a stale placeholder carrying the error message.
 *
 * @param {string} dir
 * @param {string} id
 * @param {Awaited<ReturnType<typeof prepareScan>>} scan
 * @returns {Promise<RawFlow|null>}
 */
async function collectFlowSafe(dir, id, scan) {
  let dirStat;
  try {
    dirStat = await fs.stat(dir);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    log.warn('cannot stat flow directory', { dir, error: err.message });
    return placeholderFlow(dir, id, `cannot stat flow directory: ${err.message}`, new Date(0));
  }
  try {
    return await collectFlow(dir, id, dirStat, scan);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    log.warn('unexpected error while reading flow', { dir, error: err && err.message });
    return placeholderFlow(dir, id, `unexpected error: ${err && err.message}`, dirStat.mtime);
  }
}

/**
 * @param {string} dir
 * @param {string} id
 * @param {string} error
 * @param {Date} mtime
 * @returns {RawFlow}
 */
function placeholderFlow(dir, id, error, mtime) {
  return {
    id,
    dir,
    def: null,
    defError: error,
    header: null,
    headerError: error,
    format: 'unknown',
    label: '',
    description: '',
    mediaType: '',
    groupHint: '',
    group: '',
    role: '',
    summary: '',
    active: null,
    writerPid: null,
    writerContainerId: null,
    grainFiles: null,
    sizeBytes: 0,
    mtime: mtime.toISOString(),
  };
}

/**
 * @param {string} dir
 * @param {string} id
 * @param {import('node:fs').Stats} dirStat
 * @param {Awaited<ReturnType<typeof prepareScan>>} scan
 * @returns {Promise<RawFlow>}
 */
async function collectFlow(dir, id, dirStat, scan) {
  const [defResult, headerResult, topLevel, grains] = await Promise.all([
    readFlowDef(path.join(dir, 'flow_def.json')),
    readHeader(path.join(dir, 'data')),
    sumFileSizes(dir),
    sumFileSizes(path.join(dir, 'grains')),
  ]);
  if (defResult.error === 'flow_def.json missing' && headerResult.error === 'data file missing') {
    // Both files gone: the directory was most likely removed between the directory scan and
    // the reads (garbage collection, a concurrent delete). Drop it instead of reporting a ghost.
    try {
      await fs.access(dir);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw err;
    }
  }
  const def = defResult.def;
  const header = headerResult.header;
  const format = resolveFormat(def, header);

  let active = null;
  let writerPid = null;
  let writerContainerId = null;
  if (scan.locks !== null) {
    const held = headerResult.stat ? findLocksForFile(scan.locks, headerResult.stat) : [];
    active = held.length > 0;
    const holder = held.find((lock) => Number.isInteger(lock.pid) && lock.pid > 0);
    writerPid = holder ? holder.pid : null;
    if (writerPid !== null && scan.resolveContainers) writerContainerId = await lookupContainer(scan, writerPid);
  }

  const discrete = format === 'video' || format === 'data' || Boolean(header && header.discrete);
  return {
    id,
    dir,
    def,
    defError: defResult.error,
    header,
    headerError: headerResult.error,
    format,
    label: stringOrEmpty(def && def.label),
    description: stringOrEmpty(def && def.description),
    mediaType: stringOrEmpty(def && def.media_type),
    ...parseGroupHint(def),
    summary: summarizeFlowDef(def),
    active,
    writerPid,
    writerContainerId,
    grainFiles: discrete ? grains.count : null,
    sizeBytes: topLevel.bytes + grains.bytes,
    mtime: dirStat.mtime.toISOString(),
  };
}

/**
 * @param {string} file
 * @returns {Promise<{ def: object|null, error: string|null }>}
 */
async function readFlowDef(file) {
  let text;
  try {
    const st = await fs.stat(file);
    if (st.size > MAX_FLOW_DEF_BYTES) {
      return { def: null, error: `flow_def.json is too large (${st.size} bytes)` };
    }
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { def: null, error: 'flow_def.json missing' };
    return { def: null, error: `cannot read flow_def.json: ${err.message}` };
  }
  try {
    const def = JSON.parse(text);
    if (!isObject(def)) return { def: null, error: 'flow_def.json is not a JSON object' };
    return { def, error: null };
  } catch (err) {
    return { def: null, error: `invalid flow_def.json: ${err.message}` };
  }
}

/**
 * Read at most {@link FLOW_INFO_SIZE} bytes of the `data` file and parse the header.
 * The stat is returned even when the header is invalid so lock matching still works.
 *
 * @param {string} file
 * @returns {Promise<{ header: FlowHeader|null, stat: import('node:fs').Stats|null, error: string|null }>}
 */
async function readHeader(file) {
  let fh;
  try {
    fh = await fs.open(file, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return { header: null, stat: null, error: 'data file missing' };
    // Unreadable (e.g. EACCES) but present: keep the stat so lock matching still reports activity.
    const stat = await fs.stat(file).catch(() => null);
    return { header: null, stat, error: `cannot open data file: ${err.message}` };
  }
  try {
    const stat = await fh.stat();
    if (!stat.isFile()) return { header: null, stat: null, error: 'data is not a regular file' };
    const length = Math.min(Number(stat.size), FLOW_INFO_SIZE);
    const buf = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await fh.read(buf, offset, length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    try {
      return { header: parseFlowInfo(buf.subarray(0, offset)), stat, error: null };
    } catch (err) {
      return { header: null, stat, error: `invalid data file: ${err.message}` };
    }
  } catch (err) {
    return { header: null, stat: null, error: `cannot read data file: ${err.message}` };
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * Number of entries in a directory and the total size of its regular files.
 * `count` is `null` when the directory cannot be read.
 *
 * @param {string} dir
 * @returns {Promise<{ count: number|null, bytes: number }>}
 */
async function sumFileSizes(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { count: null, bytes: 0 };
  }
  let bytes = 0;
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) return;
      try {
        const st = await fs.stat(path.join(dir, entry.name));
        bytes += st.size;
      } catch {
        // file vanished between readdir and stat — ignore
      }
    }),
  );
  return { count: entries.length, bytes };
}

/**
 * @param {Awaited<ReturnType<typeof prepareScan>>} scan
 * @param {number} pid
 * @returns {Promise<string|null>}
 */
function lookupContainer(scan, pid) {
  let pending = scan.containerIds.get(pid);
  if (!pending) {
    pending = containerIdForPid(pid, scan.procRoot).catch(() => null);
    scan.containerIds.set(pid, pending);
  }
  return pending;
}

// ---------------------------------------------------------------------------------------------
// assembly

/**
 * @param {RawFlow} raw
 * @param {{ offsetNs: number, nowTai: bigint }} timing
 * @returns {Flow}
 */
function finishFlow(raw, timing) {
  const { lastWriteAgeMs, latencyGrains, headTimeIso } = deriveTiming(raw, timing);
  return {
    id: raw.id,
    dir: raw.dir,
    label: raw.label,
    description: raw.description,
    groupHint: raw.groupHint,
    group: raw.group,
    role: raw.role,
    format: raw.format,
    mediaType: raw.mediaType,
    summary: raw.summary,
    def: raw.def,
    defError: raw.defError,
    header: raw.header,
    headerError: raw.headerError,
    active: raw.active,
    writerPid: raw.writerPid,
    writerContainerId: raw.writerContainerId,
    status: statusOf(raw),
    grainFiles: raw.grainFiles,
    sizeBytes: raw.sizeBytes,
    lastWriteAgeMs,
    latencyGrains,
    headTimeIso,
    mtime: raw.mtime,
  };
}

/**
 * @param {RawFlow} raw
 * @returns {'active'|'inactive'|'stale'}
 */
function statusOf(raw) {
  if (raw.active === true) return 'active';
  if (raw.header && raw.def) return 'inactive';
  return 'stale';
}

/**
 * @param {RawFlow} raw
 * @param {{ offsetNs: number, nowTai: bigint }} timing
 * @returns {{ lastWriteAgeMs: number|null, latencyGrains: number|null, headTimeIso: string|null }}
 */
function deriveTiming(raw, timing) {
  const out = { lastWriteAgeMs: null, latencyGrains: null, headTimeIso: null };
  const header = raw.header;
  if (!header) return out;

  // Continuous (audio) flows only stamp lastWriteTime once, at creation; its age says nothing.
  const continuous = header.continuous !== null || raw.format === 'audio';
  const lastWrite = toBigIntOrNull(header.lastWriteTime);
  if (!continuous && lastWrite !== null && lastWrite > 0n) {
    out.lastWriteAgeMs = Number(timing.nowTai - lastWrite) / 1e6;
  }

  const rate = pickRate(header, raw.def, raw.format);
  const head = toBigIntOrNull(header.headIndex);
  if (rate && head !== null) {
    try {
      out.latencyGrains = Number(timestampToIndex(rate, timing.nowTai) - head);
      const unixNs = indexToTimestamp(rate, head) - BigInt(Math.trunc(timing.offsetNs));
      out.headTimeIso = isoFromUnixNs(unixNs);
    } catch {
      // arithmetic on a corrupt header — leave the fields null
    }
  }
  return out;
}

/**
 * Rate used for index arithmetic: the header's grain rate when valid, else the definition's.
 *
 * @param {FlowHeader} header
 * @param {object|null} def
 * @param {string} format
 * @returns {{ numerator: number, denominator: number }|null}
 */
function pickRate(header, def, format) {
  const fromHeader = validRate(header.grainRate);
  if (fromHeader) return fromHeader;
  if (!isObject(def)) return null;
  return validRate(format === 'audio' ? def.sample_rate : def.grain_rate);
}

/**
 * @param {unknown} rate
 * @returns {{ numerator: number, denominator: number }|null}
 */
function validRate(rate) {
  if (!isObject(rate)) return null;
  const numerator = Number(rate.numerator);
  const denominator = rate.denominator === undefined || rate.denominator === null ? 1 : Number(rate.denominator);
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || numerator <= 0 || denominator <= 0) return null;
  return { numerator, denominator };
}

/**
 * @param {bigint} unixNs
 * @returns {string|null}
 */
function isoFromUnixNs(unixNs) {
  const ms = Number(unixNs / 1_000_000n);
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS) return null;
  return new Date(ms).toISOString();
}

/**
 * @param {object|null} def
 * @param {FlowHeader|null} header
 * @returns {'video'|'audio'|'data'|'unknown'}
 */
function resolveFormat(def, header) {
  const fromDef = formatFromDef(def);
  if (fromDef && fromDef !== 'unknown') return fromDef;
  if (header && KNOWN_FORMATS.has(header.format)) return header.format;
  return 'unknown';
}

/**
 * @param {object|null|undefined} def
 * @returns {'video'|'audio'|'data'|'unknown'|null} `null` when the definition has no format string
 */
function formatFromDef(def) {
  if (!isObject(def) || typeof def.format !== 'string') return null;
  const m = FORMAT_URN_RE.exec(def.format.trim());
  if (!m) return 'unknown';
  const name = m[1].toLowerCase();
  return KNOWN_FORMATS.has(name) ? name : 'unknown';
}

/**
 * `1920x1080p` — frame geometry plus interlace letter (`p`/`i`); `""` when unknown.
 * @param {object} def
 * @returns {string}
 */
function geometryText(def) {
  const width = Number(def.frame_width);
  const height = Number(def.frame_height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return '';
  const mode = typeof def.interlace_mode === 'string' ? def.interlace_mode.toLowerCase() : '';
  const scan = mode === 'progressive' ? 'p' : mode.startsWith('interlaced') ? 'i' : '';
  return `${width}x${height}${scan}`;
}

/**
 * `30000/1001` — rational as text with the denominator defaulting to 1; `""` when invalid.
 * @param {unknown} rate
 * @returns {string}
 */
function rationalText(rate) {
  const valid = validRate(rate);
  return valid ? `${valid.numerator}/${valid.denominator}` : '';
}

/**
 * `48000` (or `num/den` for non-integer rates); `""` when invalid.
 * @param {unknown} rate
 * @returns {string}
 */
function sampleRateText(rate) {
  const valid = validRate(rate);
  if (!valid) return '';
  return valid.denominator === 1 ? String(valid.numerator) : `${valid.numerator}/${valid.denominator}`;
}

/**
 * @param {Flow} a
 * @param {Flow} b
 * @returns {number}
 */
function compareFlows(a, b) {
  return compareText(a.group, b.group) || compareText(a.role, b.role) || compareText(a.label, b.label) || compareText(a.id, b.id);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareText(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringOrEmpty(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * @param {unknown} value
 * @returns {bigint|null}
 */
function toBigIntOrNull(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? BigInt(Math.trunc(value)) : null;
  if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) return BigInt(value.trim());
  return null;
}
