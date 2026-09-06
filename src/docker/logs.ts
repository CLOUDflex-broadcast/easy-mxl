/**
 * Container log streaming with stdout/stderr demultiplexing and streaming
 * UTF-8 decoding.
 */
import { PassThrough } from 'node:stream';
import { HttpError, toHttpError } from '../errors.js';
import { log } from '../log.js';

/**
 * @param {unknown} tail
 * @returns {number|'all'}
 */
function normalizeTail(tail) {
  if (tail === undefined || tail === null || tail === '' || tail === 'all') return 'all';
  const n = Number(tail);
  if (!Number.isInteger(n) || n < 0) {
    throw new HttpError(400, 'invalid_tail', 'tail must be a non-negative integer or "all"');
  }
  return n;
}

/**
 * @param {unknown} since unix seconds, milliseconds-free ISO string, or 0/undefined
 * @returns {number|null} unix seconds
 */
function normalizeSince(since) {
  if (since === undefined || since === null || since === '' || since === 0 || since === '0') return null;
  if (typeof since === 'string' && Number.isNaN(Number(since))) {
    const ms = Date.parse(since);
    if (Number.isNaN(ms)) throw new HttpError(400, 'invalid_since', 'since must be unix seconds or an ISO date');
    return Math.floor(ms / 1000);
  }
  const n = Number(since);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'invalid_since', 'since must be unix seconds or an ISO date');
  return Math.floor(n);
}

/**
 * Dockerode returns a stream for `follow: true` and a Buffer (or, when the
 * whole body happens to parse as JSON, an object) otherwise. Normalise to a
 * readable stream.
 * @param {unknown} raw
 * @returns {import('node:stream').Readable}
 */
function toReadable(raw) {
  if (raw && typeof raw === 'object' && typeof raw.on === 'function' && typeof raw.pipe === 'function') {
    return /** @type {any} */ (raw);
  }
  const pt = new PassThrough();
  let buf;
  if (Buffer.isBuffer(raw)) buf = raw;
  else if (typeof raw === 'string') buf = Buffer.from(raw, 'utf8');
  else if (raw === undefined || raw === null) buf = Buffer.alloc(0);
  else buf = Buffer.from(JSON.stringify(raw) + '\n', 'utf8');
  pt.end(buf);
  return pt;
}

/**
 * Stream a container's logs to a sink.
 *
 * The container is inspected first: TTY containers produce a raw stream (all
 * text reported as `stdout`), others are demultiplexed with
 * `docker.modem.demuxStream`. Text is decoded with one streaming
 * `TextDecoder` per stream so multi-byte characters split across chunks
 * survive. `stop()` is idempotent and destroys the underlying stream.
 *
 * @param {import('dockerode')} docker
 * @param {string} id container id or name
 * @param {{ tail?: number|'all', since?: number|string, timestamps?: boolean, follow?: boolean }} [opts]
 * @param {{ onChunk?: (stream: 'stdout'|'stderr', text: string) => void, onEnd?: () => void, onError?: (err: HttpError) => void }} [sink]
 * @returns {Promise<{ stop(): void }>}
 * @throws {HttpError} 404 when the container does not exist, 400 on bad options
 */
export async function streamLogs(docker, id, { tail = 200, since = 0, timestamps = false, follow = true } = {}, sink = {}) {
  if (typeof id !== 'string' || !id.trim()) {
    throw new HttpError(400, 'invalid_container_id', 'Container id or name is required');
  }
  const logOpts = { follow: !!follow, stdout: true, stderr: true, tail: normalizeTail(tail), timestamps: !!timestamps };
  const sinceSeconds = normalizeSince(since);
  if (sinceSeconds !== null) logOpts.since = sinceSeconds;

  const container = docker.getContainer(id.trim());
  let info;
  let raw;
  try {
    info = await container.inspect();
    raw = await container.logs(logOpts);
  } catch (err) {
    throw toHttpError(err);
  }
  const tty = !!(info && info.Config && info.Config.Tty);
  const source = toReadable(raw);

  let done = false;
  let stopped = false;

  const emit = (stream, text) => {
    if (!text || done) return;
    try {
      if (typeof sink.onChunk === 'function') sink.onChunk(stream, text);
    } catch (err) {
      log.warn('log sink onChunk threw; stopping stream', { id, error: err });
      stop();
    }
  };
  const makeTarget = (stream) => {
    const decoder = new TextDecoder('utf-8');
    return {
      write(chunk) {
        emit(stream, decoder.decode(chunk, { stream: true }));
        return true;
      },
      flush() {
        emit(stream, decoder.decode());
      },
    };
  };
  const stdout = makeTarget('stdout');
  const stderr = makeTarget('stderr');

  const finish = (err) => {
    if (done) return;
    stdout.flush();
    stderr.flush();
    done = true;
    try {
      if (err && !stopped) {
        if (typeof sink.onError === 'function') sink.onError(toHttpError(err));
      } else if (typeof sink.onEnd === 'function') {
        sink.onEnd();
      }
    } catch (hookErr) {
      log.warn('log sink end/error handler threw', { id, error: hookErr });
    }
  };

  function stop() {
    if (stopped) return;
    stopped = true;
    source.destroy();
    finish(null);
  }

  source.once('error', (err) => finish(err));
  source.once('end', () => finish(null));
  source.once('close', () => finish(null));

  if (tty) {
    source.on('data', (chunk) => stdout.write(chunk));
  } else {
    docker.modem.demuxStream(source, stdout, stderr);
  }

  return { stop };
}
