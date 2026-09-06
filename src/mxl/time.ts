/**
 * TAI offset estimation.
 *
 * MXL timestamps are TAI nanoseconds (CLOCK_TAI). Node only exposes UTC time, so the
 * offset TAI − UTC has to come from somewhere else:
 *
 *  1. `python3 -c 'import time;print(time.clock_gettime_ns(time.CLOCK_TAI)-time.time_ns())'`
 *     when python3 is installed (source `'python3'`). The kernel's tai offset is 37 s on
 *     a host with a configured NTP/PTP tai offset and 0 on a host where it was never set.
 *  2. Otherwise 0 (source `'assumed-zero'`), refined to `'estimated'` when a caller supplies
 *     the `lastWriteTime` of an actively written discrete flow that clearly reveals a
 *     0 s or 37 s offset (see {@link estimateOffsetFromWrite}).
 *
 * The probe result is cached and refreshed at most every 10 minutes.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from '../log.js';

const execFileAsync = promisify(execFile);

const PROBE_SCRIPT = 'import time;print(time.clock_gettime_ns(time.CLOCK_TAI)-time.time_ns())';
const PROBE_TIMEOUT_MS = 2000;
const REFRESH_MS = 10 * 60 * 1000;
const TAI_UTC_OFFSET_NS = 37e9;
const ESTIMATE_TOLERANCE_NS = 5e9;
/** Anything beyond ±100 s cannot be a TAI−UTC offset; treat it as a broken probe. */
const MAX_PLAUSIBLE_OFFSET_NS = 100e9;

/** @type {{ offsetNs: number, source: 'python3'|'assumed-zero'|'estimated', probed: boolean, at: number }|null} */
let cache = null;
/** @type {Promise<void>|null} */
let inflight = null;

/**
 * @typedef {object} TaiOffsetOptions
 * @property {boolean} [force=false] ignore the cache and probe again
 * @property {number} [maxAgeMs=600000] cache lifetime
 * @property {bigint|number|string|null} [activeWriteTimeNs] `lastWriteTime` (TAI ns) of a flow that is
 *   being written right now; used to estimate the offset when the python probe is unavailable
 * @property {(file: string, args: string[], options: object) => Promise<{ stdout: string }>} [execFile]
 *   injectable process runner (tests)
 * @property {() => number} [now] injectable clock returning Unix milliseconds (tests)
 */

/**
 * TAI − UTC offset in nanoseconds. Cached; the python probe runs at most every 10 minutes.
 * After each call `getTaiOffsetNs.source` tells where the value came from:
 * `'python3'`, `'assumed-zero'` or `'estimated'`.
 *
 * @param {TaiOffsetOptions} [opts]
 * @returns {Promise<number>}
 */
export async function getTaiOffsetNs(opts = {}) {
  const {
    force = false,
    maxAgeMs = REFRESH_MS,
    activeWriteTimeNs = null,
    execFile: exec = execFileAsync,
    now = Date.now,
  } = opts;
  const nowMs = now();

  if (force || cache === null || nowMs - cache.at >= maxAgeMs) {
    if (inflight === null) {
      inflight = probeClockTai(exec)
        .then((result) => {
          cache = { ...result, at: now() };
        })
        .finally(() => {
          inflight = null;
        });
    }
    await inflight;
  }

  if (!cache.probed && activeWriteTimeNs !== null && activeWriteTimeNs !== undefined) {
    const estimate = estimateOffsetFromWrite(activeWriteTimeNs, BigInt(nowMs) * 1_000_000n);
    if (estimate !== null) {
      cache.offsetNs = estimate;
      cache.source = 'estimated';
    }
  }

  getTaiOffsetNs.source = cache.source;
  return cache.offsetNs;
}
/** @type {'python3'|'assumed-zero'|'estimated'} */
getTaiOffsetNs.source = 'assumed-zero';

/**
 * Current TAI time in nanoseconds: `BigInt(Date.now()) * 1_000_000n + BigInt(offsetNs)`.
 *
 * @param {number|bigint} [offsetNs=0] TAI − UTC offset (from {@link getTaiOffsetNs})
 * @returns {bigint}
 */
export function nowTaiNs(offsetNs = 0) {
  return BigInt(Date.now()) * 1_000_000n + toOffsetBigInt(offsetNs);
}

/**
 * Guess the TAI offset from the `lastWriteTime` of a flow that is being written right now.
 * `diff = lastWriteTimeNs − nowUnixNs`: returns `37e9` when `|diff − 37e9| < 5e9`,
 * `0` when `|diff| < 5e9`, otherwise `null` (the write is not recent or the clocks disagree).
 *
 * @param {bigint|number|string} lastWriteTimeNs TAI ns from the flow header
 * @param {bigint|number|string} nowUnixNs current Unix time in ns
 * @returns {number|null}
 */
export function estimateOffsetFromWrite(lastWriteTimeNs, nowUnixNs) {
  const lastWrite = toBigIntOrNull(lastWriteTimeNs);
  const nowNs = toBigIntOrNull(nowUnixNs);
  if (lastWrite === null || nowNs === null) return null;
  const diff = Number(lastWrite - nowNs);
  if (Math.abs(diff - TAI_UTC_OFFSET_NS) < ESTIMATE_TOLERANCE_NS) return TAI_UTC_OFFSET_NS;
  if (Math.abs(diff) < ESTIMATE_TOLERANCE_NS) return 0;
  return null;
}

/**
 * Run the python3 CLOCK_TAI probe.
 * @param {(file: string, args: string[], options: object) => Promise<{ stdout: string }>} exec
 * @returns {Promise<{ offsetNs: number, source: 'python3'|'assumed-zero', probed: boolean }>}
 */
async function probeClockTai(exec) {
  try {
    const { stdout } = await exec('python3', ['-c', PROBE_SCRIPT], {
      timeout: PROBE_TIMEOUT_MS,
      encoding: 'utf8',
      windowsHide: true,
    });
    const text = String(stdout).trim();
    if (!/^-?\d+$/.test(text)) {
      throw new Error(`unexpected probe output ${JSON.stringify(text.slice(0, 60))}`);
    }
    const value = Number(text);
    if (!Number.isFinite(value) || Math.abs(value) > MAX_PLAUSIBLE_OFFSET_NS) {
      throw new Error(`implausible TAI offset ${text} ns`);
    }
    return { offsetNs: value, source: 'python3', probed: true };
  } catch (err) {
    log.debug('CLOCK_TAI probe unavailable, assuming TAI == UTC', { error: err && err.message });
    return { offsetNs: 0, source: 'assumed-zero', probed: false };
  }
}

/**
 * @param {unknown} value
 * @returns {bigint}
 */
function toOffsetBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  const parsed = toBigIntOrNull(value);
  if (parsed === null) throw new TypeError('offsetNs must be a finite number or bigint');
  return parsed;
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
