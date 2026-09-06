/**
 * Interactive terminals inside containers (docker exec with a TTY).
 */
import { HttpError, toHttpError } from '../errors.js';
import { log } from '../log.js';

/** Default command: bash when available, otherwise sh. */
export const DEFAULT_SHELL_CMD = ['/bin/sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'];

const EXIT_POLL_INTERVAL_MS = 100;
const EXIT_POLL_MAX_MS = 2000;

/**
 * @param {unknown} cmd
 * @returns {string[]}
 */
function normalizeCmd(cmd) {
  if (cmd === undefined || cmd === null || cmd === '') return [...DEFAULT_SHELL_CMD];
  if (typeof cmd === 'string') {
    const parts = cmd.trim().split(/\s+/).filter(Boolean);
    return parts.length ? parts : [...DEFAULT_SHELL_CMD];
  }
  if (Array.isArray(cmd) && cmd.length && cmd.every((s) => typeof s === 'string')) return [...cmd];
  throw new HttpError(400, 'invalid_cmd', 'cmd must be a command string or an array of strings');
}

/**
 * @param {unknown} env object `{K: V}` or array of `K=V` strings
 * @returns {string[]}
 */
function normalizeEnv(env) {
  if (!env) return [];
  if (Array.isArray(env)) return env.filter((s) => typeof s === 'string' && s.includes('='));
  if (typeof env === 'object') {
    return Object.entries(env)
      .filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${v}`);
  }
  throw new HttpError(400, 'invalid_env', 'env must be an object or an array of KEY=VALUE strings');
}

/**
 * @param {unknown} cols
 * @param {unknown} rows
 * @returns {{ cols: number, rows: number }}
 */
function normalizeSize(cols, rows) {
  const c = Number(cols);
  const r = Number(rows);
  return {
    cols: Number.isInteger(c) && c >= 2 && c <= 1000 ? c : 80,
    rows: Number.isInteger(r) && r >= 2 && r <= 1000 ? r : 24,
  };
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `exec.inspect()` until the process reports it has stopped.
 * @param {{ inspect(): Promise<{ Running?: boolean, ExitCode?: number|null }> }} exec
 * @returns {Promise<number|null>} exit code, or null when unknown
 */
async function pollExitCode(exec) {
  const deadline = Date.now() + EXIT_POLL_MAX_MS;
  for (;;) {
    try {
      const info = await exec.inspect();
      if (info && info.Running === false) {
        return typeof info.ExitCode === 'number' ? info.ExitCode : null;
      }
    } catch (err) {
      log.debug('exec inspect failed while resolving exit code', { error: err });
      return null;
    }
    if (Date.now() >= deadline) return null;
    await sleep(EXIT_POLL_INTERVAL_MS);
  }
}

/**
 * Open an interactive TTY exec session in a running container.
 *
 * @param {import('dockerode')} docker
 * @param {string} id container id or name
 * @param {{ cmd?: string|string[], cols?: number, rows?: number, user?: string, env?: object|string[] }} [opts]
 * @returns {Promise<{ stream: import('node:stream').Duplex, resize(cols: number, rows: number): Promise<void>, write(data: string|Buffer): boolean, close(): void, exec: object, onExit(cb: (code: number|null) => void): void }>}
 * @throws {HttpError} 404 unknown container, 409 `not_running`
 */
export async function openTerminal(docker, id, { cmd, cols = 80, rows = 24, user, env } = {}) {
  if (typeof id !== 'string' || !id.trim()) {
    throw new HttpError(400, 'invalid_container_id', 'Container id or name is required');
  }
  const Cmd = normalizeCmd(cmd);
  const Env = ['TERM=xterm-256color', ...normalizeEnv(env)];
  const container = docker.getContainer(id.trim());

  let info;
  try {
    info = await container.inspect();
  } catch (err) {
    throw toHttpError(err);
  }
  if (!info || !info.State || !info.State.Running) {
    const name = typeof info?.Name === 'string' ? info.Name.replace(/^\//, '') : id;
    throw new HttpError(409, 'not_running', `Container "${name}" is not running (${info?.State?.Status || 'unknown'})`, { id: info?.Id ?? id, state: info?.State?.Status ?? 'unknown' });
  }

  const execOpts = { Cmd, AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true, Env };
  if (typeof user === 'string' && user.trim()) execOpts.User = user.trim();

  let exec;
  let stream;
  try {
    exec = await container.exec(execOpts);
    stream = await exec.start({ hijack: true, stdin: true, Tty: true });
  } catch (err) {
    throw toHttpError(err);
  }

  const size = normalizeSize(cols, rows);
  try {
    await exec.resize({ h: size.rows, w: size.cols });
  } catch (err) {
    log.debug('initial terminal resize failed', { id, error: err });
  }

  let closed = false;
  let exitPromise = null;
  const exitListeners = [];
  let exitResolved = false;
  let exitCode = null;

  const settleExit = () => {
    if (exitPromise) return;
    exitPromise = pollExitCode(exec).then((code) => {
      exitResolved = true;
      exitCode = code;
      for (const cb of exitListeners.splice(0)) {
        try {
          cb(code);
        } catch (err) {
          log.warn('terminal onExit callback threw', { id, error: err });
        }
      }
    });
  };
  stream.once('end', settleExit);
  stream.once('close', settleExit);
  stream.once('error', (err) => {
    log.debug('terminal stream error', { id, error: err });
    settleExit();
  });

  return {
    stream,
    exec,
    resize(newCols, newRows) {
      const s = normalizeSize(newCols, newRows);
      return exec.resize({ h: s.rows, w: s.cols }).then(
        () => undefined,
        (err) => {
          throw toHttpError(err);
        },
      );
    },
    write(data) {
      if (closed || stream.destroyed || !stream.writable) return false;
      return stream.write(data);
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        stream.end();
      } catch (err) {
        log.debug('terminal stream end failed', { id, error: err });
      }
      stream.destroy();
    },
    onExit(cb) {
      if (typeof cb !== 'function') return;
      if (exitResolved) {
        queueMicrotask(() => cb(exitCode));
        return;
      }
      exitListeners.push(cb);
    },
  };
}
