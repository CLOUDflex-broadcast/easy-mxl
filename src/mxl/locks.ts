/**
 * `/proc/locks` and `/proc/<pid>/cgroup` parsing.
 *
 * An MXL writer holds a shared `flock()` on `<flow>/data`; on Linux every flock shows up in
 * `/proc/locks` as `N: FLOCK  ADVISORY  READ <pid> <maj>:<min>:<inode> 0 EOF` (major/minor in
 * hex). Matching those entries against `fs.stat()` of the data file tells whether a flow is
 * active and which PID writes it; `/proc/<pid>/cgroup` then maps the PID to a Docker container.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * @typedef {object} LockEntry
 * @property {string} type `'FLOCK'`, `'POSIX'`, `'OFDLCK'`, `'LEASE'`, …
 * @property {boolean} mandatory `MANDATORY` vs `ADVISORY`
 * @property {string} mode `'READ'` or `'WRITE'`
 * @property {number} pid holder PID (`-1` for open-file-description locks)
 * @property {number} major device major number
 * @property {number} minor device minor number
 * @property {number} ino inode number
 * @property {string} start first locked byte (decimal string)
 * @property {string} end last locked byte or `'EOF'`
 */

/**
 * One `/proc/locks` line: `1: FLOCK  ADVISORY  READ 3026 00:1a:20 0 EOF`.
 * Blocked waiters are printed as `N: -> TYPE …`; they hold nothing and are skipped.
 */
const LOCK_LINE_RE =
  /^\s*\d+:\s+(->\s+)?([A-Z]+)\s+([A-Z]+)\s+([A-Z]+)\s+(-?\d+)\s+([0-9a-fA-F]+):([0-9a-fA-F]+):(\d+)\s+(\S+)\s+(\S+)\s*$/;

const CGROUP_DOCKER_RE = /docker[-/]([0-9a-f]{64})/;
const CGROUP_SCOPE_RE = /([0-9a-f]{64})\.scope/;

/**
 * Parse the text of `/proc/locks`. Unparseable lines and blocked waiters are ignored.
 *
 * @param {string} text
 * @returns {LockEntry[]}
 */
export function parseProcLocks(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const entries = [];
  for (const line of text.split('\n')) {
    const m = LOCK_LINE_RE.exec(line);
    if (!m || m[1]) continue;
    entries.push({
      type: m[2],
      mandatory: m[3] === 'MANDATORY',
      mode: m[4],
      pid: Number.parseInt(m[5], 10),
      major: Number.parseInt(m[6], 16),
      minor: Number.parseInt(m[7], 16),
      ino: Number.parseInt(m[8], 10),
      start: m[9],
      end: m[10],
    });
  }
  return entries;
}

/**
 * Read and parse `/proc/locks`, or `null` when the file cannot be read (non-Linux, hidepid,
 * missing /proc). Use this when "unreadable" must be told apart from "no locks".
 *
 * @param {string} [procPath='/proc/locks']
 * @returns {Promise<LockEntry[]|null>}
 */
export async function readProcLocksOrNull(procPath = '/proc/locks') {
  try {
    return parseProcLocks(await fs.readFile(procPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read and parse `/proc/locks`; `[]` when unreadable.
 *
 * @param {string} [procPath='/proc/locks']
 * @returns {Promise<LockEntry[]>}
 */
export async function readProcLocks(procPath = '/proc/locks') {
  return (await readProcLocksOrNull(procPath)) ?? [];
}

/**
 * Split a Linux `st_dev` value into major/minor (glibc `gnu_dev_major` / `gnu_dev_minor`):
 * `major = (dev >> 8) & 0xfff`, `minor = (dev & 0xff) | ((dev >> 12) & 0xfff00)`.
 *
 * @param {number|bigint} stDev `fs.Stats.dev`
 * @returns {{ major: number, minor: number }}
 */
export function devMajorMinor(stDev) {
  const dev = typeof stDev === 'bigint' ? stDev : BigInt(Math.trunc(Number(stDev)));
  return {
    major: Number((dev >> 8n) & 0xfffn),
    minor: Number((dev & 0xffn) | ((dev >> 12n) & 0xfff00n)),
  };
}

/**
 * FLOCK entries that refer to the file described by `stat` (same device major/minor and inode).
 * POSIX/OFD locks and leases are ignored because `mxlIsFlowActive` only observes flocks.
 *
 * @param {LockEntry[]} locks
 * @param {import('node:fs').Stats|import('node:fs').BigIntStats} stat
 * @returns {LockEntry[]}
 */
export function findLocksForFile(locks, stat) {
  if (!Array.isArray(locks) || !stat || stat.dev === undefined || stat.ino === undefined) return [];
  const { major, minor } = devMajorMinor(stat.dev);
  const ino = BigInt(stat.ino);
  return locks.filter(
    (lock) => lock.type === 'FLOCK' && lock.major === major && lock.minor === minor && BigInt(lock.ino) === ino,
  );
}

/**
 * Extract a 64-hex Docker container id from `/proc/<pid>/cgroup` text. Supports cgroup v1
 * (`…/docker/<id>`) and v2 / systemd (`…/docker-<id>.scope`, `…/<id>.scope`).
 *
 * @param {string} text
 * @returns {string|null}
 */
export function parseCgroupContainerId(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const docker = CGROUP_DOCKER_RE.exec(text);
  if (docker) return docker[1];
  const scope = CGROUP_SCOPE_RE.exec(text);
  return scope ? scope[1] : null;
}

/**
 * Docker container id of a PID via `<procRoot>/<pid>/cgroup`; `null` when the process is
 * gone, not containerised, or /proc is not readable.
 *
 * @param {number|string} pid
 * @param {string} [procRoot='/proc']
 * @returns {Promise<string|null>}
 */
export async function containerIdForPid(pid, procRoot = '/proc') {
  const n = typeof pid === 'string' ? Number.parseInt(pid, 10) : pid;
  if (!Number.isInteger(n) || n <= 0) return null;
  try {
    return parseCgroupContainerId(await fs.readFile(path.join(procRoot, String(n), 'cgroup'), 'utf8'));
  } catch {
    return null;
  }
}
