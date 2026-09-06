/**
 * Pure parser for the MXL `mxlFlowInfo` header (the first 2048 bytes of a flow's
 * `data` file) plus the index/time helpers mirrored from the MXL SDK
 * (`mxlTimestampToIndex` / `mxlIndexToTimestamp`).
 *
 * Every 64-bit quantity is handled with BigInt. The parsed header exposes them as
 * decimal strings so they survive JSON serialisation unchanged; callers `BigInt()`
 * them when they need arithmetic.
 */

/** Size in bytes of the `mxlFlowInfo` struct (the header of a flow's `data` file). */
export const FLOW_INFO_SIZE = 2048;

/** Format codes stored at offset 24 of the header. */
export const FORMAT = Object.freeze({ 0: 'unspecified', 1: 'video', 2: 'audio', 3: 'data' });

/** Smallest byte count that still contains every field parsed here (`lastReadTime` ends at 224). */
const MIN_FLOW_INFO_SIZE = 224;

/** Header field offsets (little-endian). */
const OFFSET = Object.freeze({
  version: 0,
  size: 4,
  id: 8,
  format: 24,
  flags: 28,
  rateNumerator: 32,
  rateDenominator: 40,
  maxCommitBatchSizeHint: 48,
  maxSyncBatchSizeHint: 52,
  payloadLocation: 56,
  deviceIndex: 60,
  config: 136, // union: discrete { u32 sliceSizes[4]; u32 grainCount } | continuous { u32 channelCount; u32 bufferLength }
  grainCount: 152,
  bufferLength: 140,
  headIndex: 200,
  lastWriteTime: 208,
  lastReadTime: 216,
});

const NS_PER_SECOND = 1_000_000_000n;

/**
 * @typedef {object} Rate
 * @property {number|bigint|string} numerator
 * @property {number|bigint|string} [denominator] defaults to 1 (NMOS `sample_rate` may omit it)
 */

/**
 * @typedef {object} FlowHeader
 * @property {number} version
 * @property {number} size
 * @property {string} id flow UUID, lowercase 8-4-4-4-12
 * @property {'video'|'audio'|'data'|'unspecified'} format
 * @property {number} formatCode raw value at offset 24
 * @property {number} flags
 * @property {{ numerator: number, denominator: number }} grainRate
 * @property {number} maxCommitBatchSizeHint
 * @property {number} maxSyncBatchSizeHint
 * @property {'host'|'device'|'unknown'} payloadLocation
 * @property {number} deviceIndex
 * @property {{ sliceSizes: number[], grainCount: number }|null} discrete present for video/data flows
 * @property {{ channelCount: number, bufferLength: number }|null} continuous present for audio flows
 * @property {string} headIndex u64 as decimal string
 * @property {string} lastWriteTime u64 TAI nanoseconds as decimal string
 * @property {string} lastReadTime u64 TAI nanoseconds as decimal string
 */

/**
 * Parse an `mxlFlowInfo` header.
 *
 * Only the first {@link FLOW_INFO_SIZE} bytes are meaningful; any buffer of at least
 * 224 bytes is accepted so truncated captures still parse.
 *
 * @param {Buffer|Uint8Array} buf raw bytes of the `data` file
 * @returns {FlowHeader}
 * @throws {RangeError} when fewer than 224 bytes are supplied
 * @throws {TypeError} when `buf` is not a byte buffer
 */
export function parseFlowInfo(buf) {
  const b = toBuffer(buf);
  if (b.length < MIN_FLOW_INFO_SIZE) {
    throw new RangeError(`flow info header too short: ${b.length} bytes (need at least ${MIN_FLOW_INFO_SIZE})`);
  }
  const formatCode = b.readUInt32LE(OFFSET.format);
  const format = FORMAT[formatCode] ?? 'unspecified';
  const payloadCode = b.readUInt32LE(OFFSET.payloadLocation);

  const discrete = format === 'video' || format === 'data'
    ? {
        sliceSizes: [0, 4, 8, 12].map((rel) => b.readUInt32LE(OFFSET.config + rel)),
        grainCount: b.readUInt32LE(OFFSET.grainCount),
      }
    : null;
  const continuous = format === 'audio'
    ? {
        channelCount: b.readUInt32LE(OFFSET.config),
        bufferLength: b.readUInt32LE(OFFSET.bufferLength),
      }
    : null;

  return {
    version: b.readUInt32LE(OFFSET.version),
    size: b.readUInt32LE(OFFSET.size),
    id: uuidFromBytes(b, OFFSET.id),
    format,
    formatCode,
    flags: b.readUInt32LE(OFFSET.flags),
    grainRate: {
      numerator: Number(b.readBigInt64LE(OFFSET.rateNumerator)),
      denominator: Number(b.readBigInt64LE(OFFSET.rateDenominator)),
    },
    maxCommitBatchSizeHint: b.readUInt32LE(OFFSET.maxCommitBatchSizeHint),
    maxSyncBatchSizeHint: b.readUInt32LE(OFFSET.maxSyncBatchSizeHint),
    payloadLocation: payloadCode === 0 ? 'host' : payloadCode === 1 ? 'device' : 'unknown',
    deviceIndex: b.readInt32LE(OFFSET.deviceIndex),
    discrete,
    continuous,
    headIndex: b.readBigUInt64LE(OFFSET.headIndex).toString(),
    lastWriteTime: b.readBigUInt64LE(OFFSET.lastWriteTime).toString(),
    lastReadTime: b.readBigUInt64LE(OFFSET.lastReadTime).toString(),
  };
}

/**
 * Grain (or sample) index for a TAI timestamp, rounded half-up exactly like the
 * MXL SDK (`mxl-internal/IndexConversion.hpp`):
 * `floor((tsNs * numerator + 5e8 * denominator) / (denominator * 1e9))`.
 *
 * @param {Rate} rate grain rate (video/data) or sample rate (audio)
 * @param {bigint|number|string} tsNs TAI nanoseconds since the SMPTE ST 2059 epoch
 * @returns {bigint}
 * @throws {RangeError} when the rate is not a positive rational
 * @throws {TypeError} when `tsNs` is not an integer value
 */
export function timestampToIndex(rate, tsNs) {
  const { numerator, denominator } = normalizeRate(rate);
  const ts = requireInteger(tsNs, 'tsNs');
  return floorDiv(ts * numerator + (NS_PER_SECOND / 2n) * denominator, denominator * NS_PER_SECOND);
}

/**
 * TAI timestamp (ns) of a grain/sample index, rounded like the MXL SDK:
 * `floor((index * denominator * 1e9 + numerator / 2) / numerator)`.
 *
 * @param {Rate} rate
 * @param {bigint|number|string} index
 * @returns {bigint}
 * @throws {RangeError} when the rate is not a positive rational
 * @throws {TypeError} when `index` is not an integer value
 */
export function indexToTimestamp(rate, index) {
  const { numerator, denominator } = normalizeRate(rate);
  const idx = requireInteger(index, 'index');
  return floorDiv(idx * denominator * NS_PER_SECOND + numerator / 2n, numerator);
}

/**
 * Duration of one grain/sample in nanoseconds (floating point, e.g. 33366666.67 for 30000/1001).
 *
 * @param {Rate} rate
 * @returns {number}
 * @throws {RangeError} when the rate is not a positive rational
 */
export function grainDurationNs(rate) {
  const { numerator, denominator } = normalizeRate(rate);
  return (Number(denominator) * 1e9) / Number(numerator);
}

/**
 * Render 16 bytes as a lowercase RFC 4122 UUID string (8-4-4-4-12).
 *
 * @param {Buffer|Uint8Array} buf
 * @param {number} [offset=0] byte offset of the first UUID byte
 * @returns {string}
 * @throws {RangeError} when fewer than 16 bytes are available at `offset`
 */
export function uuidFromBytes(buf, offset = 0) {
  const b = toBuffer(buf);
  if (!Number.isInteger(offset) || offset < 0 || offset + 16 > b.length) {
    throw new RangeError(`cannot read a UUID at offset ${offset}: buffer has ${b.length} bytes`);
  }
  const hex = b.toString('hex', offset, offset + 16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * @param {unknown} buf
 * @returns {Buffer}
 */
function toBuffer(buf) {
  if (Buffer.isBuffer(buf)) return buf;
  if (buf instanceof Uint8Array) return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  throw new TypeError('expected a Buffer or Uint8Array');
}

/**
 * Convert an integer-valued number, decimal string or bigint to BigInt; `null` otherwise.
 * @param {unknown} value
 * @returns {bigint|null}
 */
function toBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value) : null;
  if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) return BigInt(value.trim());
  return null;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {bigint}
 */
function requireInteger(value, name) {
  const big = toBigInt(value);
  if (big === null) throw new TypeError(`${name} must be an integer (bigint, integer number or decimal string)`);
  return big;
}

/**
 * @param {Rate} rate
 * @returns {{ numerator: bigint, denominator: bigint }}
 */
function normalizeRate(rate) {
  if (!rate || typeof rate !== 'object') {
    throw new RangeError('rate must be an object { numerator, denominator }');
  }
  const numerator = toBigInt(rate.numerator);
  const denominator = rate.denominator === undefined || rate.denominator === null ? 1n : toBigInt(rate.denominator);
  if (numerator === null || denominator === null || numerator <= 0n || denominator <= 0n) {
    throw new RangeError(
      `invalid rate ${String(rate.numerator)}/${String(rate.denominator ?? 1)}: numerator and denominator must be positive integers`,
    );
  }
  return { numerator, denominator };
}

/**
 * Floor division for BigInt (`/` truncates toward zero).
 * @param {bigint} a
 * @param {bigint} b non-zero
 * @returns {bigint}
 */
function floorDiv(a, b) {
  const q = a / b;
  return a % b !== 0n && (a < 0n) !== (b < 0n) ? q - 1n : q;
}
