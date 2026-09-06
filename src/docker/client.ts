/**
 * Dockerode client construction and a health probe.
 */
import Dockerode from 'dockerode';
import { toHttpError } from '../errors.js';

const DEFAULT_UNIX_SOCKET = '/var/run/docker.sock';
const DEFAULT_NPIPE = '//./pipe/docker_engine';

/**
 * Translate a `DOCKER_HOST`-style string into Dockerode constructor options.
 *
 * Accepts `unix:///path`, `npipe:////./pipe/name`, `tcp://host:port`,
 * `http(s)://host:port`, `ssh://user@host[:port]`, a bare `host:port` and a
 * bare absolute socket path. Returns `null` for an empty value, meaning
 * "use Dockerode's defaults" (the `DOCKER_HOST` environment variable or the
 * default socket).
 *
 * @param {string|null|undefined} dockerHost
 * @returns {object|null}
 * @throws {Error} when the value cannot be parsed
 */
export function parseDockerHost(dockerHost) {
  if (dockerHost === null || dockerHost === undefined) return null;
  const value = String(dockerHost).trim();
  if (!value) return null;

  if (value.startsWith('unix://')) {
    return { socketPath: value.slice('unix://'.length) || DEFAULT_UNIX_SOCKET, host: undefined };
  }
  if (value.startsWith('npipe://')) {
    return { socketPath: value.slice('npipe://'.length) || DEFAULT_NPIPE, host: undefined };
  }
  if (value.startsWith('/')) {
    return { socketPath: value, host: undefined };
  }

  const withScheme = value.includes('://') ? value : `tcp://${value}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Invalid Docker host "${dockerHost}" (expected unix:///path, tcp://host:port or ssh://user@host)`);
  }
  if (!url.hostname) {
    throw new Error(`Invalid Docker host "${dockerHost}": missing host name`);
  }
  const scheme = url.protocol.replace(/:$/, '');
  const opts = { host: url.hostname, pathPrefix: '/', socketPath: undefined };
  switch (scheme) {
    case 'ssh':
      opts.protocol = 'ssh';
      opts.port = Number(url.port) || 22;
      if (url.username) opts.username = decodeURIComponent(url.username);
      if (url.password) opts.password = decodeURIComponent(url.password);
      opts.sshOptions = { agent: process.env.SSH_AUTH_SOCK };
      break;
    case 'https':
      opts.protocol = 'https';
      opts.port = Number(url.port) || 2376;
      break;
    case 'http':
      opts.protocol = 'http';
      opts.port = Number(url.port) || 2375;
      break;
    case 'tcp':
      opts.port = Number(url.port) || 2375;
      opts.protocol = opts.port === 2376 || process.env.DOCKER_TLS_VERIFY === '1' ? 'https' : 'http';
      break;
    default:
      throw new Error(`Invalid Docker host "${dockerHost}": unsupported scheme "${scheme}"`);
  }
  return opts;
}

/**
 * Create a Dockerode instance honouring `config.dockerHost`; falls back to
 * Dockerode's defaults (env `DOCKER_HOST`, then the default socket) when unset.
 *
 * @param {{ dockerHost?: string|null }} [config]
 * @returns {Dockerode}
 */
export function createDocker(config = {}) {
  const opts = parseDockerHost(config && config.dockerHost);
  return opts ? new Dockerode(opts) : new Dockerode();
}

/**
 * Race a promise against a timeout.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Docker did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Probe the daemon (`/version` + `/info`). Never throws.
 *
 * @param {Dockerode} docker
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: true, version: string|null, apiVersion: string|null, os: string|null, arch: string|null, kernel: string|null, containers: number|null, images: number|null } | { ok: false, error: string }>}
 */
export async function pingDocker(docker, { timeoutMs = 5000 } = {}) {
  try {
    const [version, info] = await withTimeout(Promise.all([docker.version(), docker.info()]), timeoutMs);
    const v = version || {};
    const i = info || {};
    return {
      ok: true,
      version: v.Version ?? null,
      apiVersion: v.ApiVersion ?? null,
      os: v.Os ?? i.OperatingSystem ?? null,
      arch: v.Arch ?? i.Architecture ?? null,
      kernel: v.KernelVersion ?? i.KernelVersion ?? null,
      containers: typeof i.Containers === 'number' ? i.Containers : null,
      images: typeof i.Images === 'number' ? i.Images : null,
    };
  } catch (err) {
    return { ok: false, error: toHttpError(err).message };
  }
}
