#!/usr/bin/env node
/**
 * EASY MXL command-line entry point: parse flags, load the catalog, prepare
 * the domain root, start the HTTP/WebSocket server and shut down cleanly on
 * SIGINT/SIGTERM.
 */
import { loadCatalog } from '../src/catalog.js';
import { loadConfig, printHelp } from '../src/config.js';
import { createDocker, pingDocker } from '../src/docker/client.js';
import { createJobRegistry } from '../src/jobs.js';
import { log, setLogLevel } from '../src/log.js';
import { ensureRoot } from '../src/mxl/domain.js';
import { createServer } from '../src/server.js';

const SHUTDOWN_GRACE_MS = 5000;

/**
 * @param {string} host bind address
 * @returns {boolean} true for loopback addresses only
 */
function isLoopback(host: string): boolean {
  const h = String(host).trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h.startsWith('127.') || h.startsWith('::ffff:127.');
}

/**
 * @param {string} host
 * @param {number} port
 * @returns {string}
 */
function formatUrl(host: string, port: number): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

/**
 * @returns {Promise<number|null>} exit code, or `null` when the server keeps running
 */
async function main(): Promise<number | null> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`easy-mxl: ${err.message}\nRun "easy-mxl --help" for usage.\n`);
    return 1;
  }
  if (config.help) {
    process.stdout.write(printHelp());
    return 0;
  }
  if (config.showVersion) {
    process.stdout.write(`${config.version}\n`);
    return 0;
  }
  setLogLevel(config.logLevel);

  let docker;
  try {
    docker = createDocker(config);
  } catch (err) {
    log.error(`Invalid Docker endpoint: ${err.message}`);
    return 1;
  }

  let catalog;
  try {
    catalog = await loadCatalog(config.catalogPaths);
  } catch (err) {
    log.error(`Cannot load the app catalog: ${err.message}`);
    log.error(`Catalog files: ${config.catalogPaths.join(', ')}`);
    return 1;
  }
  log.info(`catalog: ${catalog.length} app(s) from ${config.catalogPaths.length} file(s)`);

  try {
    await ensureRoot(config.domainRoot, { uid: config.domainUid, gid: config.domainGid, mode: config.domainMode });
  } catch (err) {
    log.warn(`Cannot prepare domain root ${config.domainRoot}: ${err.message} (creating domains may fail)`);
  }

  const server = createServer(config, { docker, catalog, jobs: createJobRegistry(), log });

  let address;
  try {
    address = await server.start();
  } catch (err) {
    const where = `${formatUrl(config.host, config.port)}`;
    if (err && err.code === 'EADDRINUSE') {
      log.error(`Cannot listen on ${where}: the port is already in use. Stop the other process or choose another port with --port / EASY_MXL_PORT.`);
    } else if (err && err.code === 'EACCES') {
      log.error(`Cannot listen on ${where}: permission denied (ports below 1024 need root or CAP_NET_BIND_SERVICE).`);
    } else if (err && err.code === 'EADDRNOTAVAIL') {
      log.error(`Cannot listen on ${where}: the address is not available on this host. Check --host / EASY_MXL_HOST.`);
    } else {
      log.error(`Cannot start the HTTP server on ${where}: ${err && err.message ? err.message : err}`);
    }
    await server.stop().catch(() => {});
    return 1;
  }

  const ping = await pingDocker(docker);
  if (!ping.ok) {
    log.warn(`Docker daemon unreachable: ${ping.error}. Container features will fail until it is back; domains still work.`);
  }
  process.stdout.write(
    `EASY MXL v${config.version} listening on ${formatUrl(address.host, address.port)}  (domain root ${config.domainRoot}, docker ${ping.ok ? 'ok' : 'unreachable'})\n`,
  );

  if (!isLoopback(config.host) && !config.token) {
    log.warn('*'.repeat(78));
    log.warn(`* SECURITY WARNING: listening on ${config.host} WITHOUT a token.`);
    log.warn('* Anyone who can reach this port controls Docker on this host (root-equivalent).');
    log.warn('* Set --token <secret> or EASY_MXL_TOKEN=<secret>, or bind to 127.0.0.1.');
    log.warn('*'.repeat(78));
  }

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received, shutting down`);
    const timer = setTimeout(() => {
      log.warn('shutdown timed out, exiting');
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
    timer.unref();
    server.stop().then(
      () => process.exit(0),
      (err) => {
        log.error('error while stopping', { error: err && err.message });
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled promise rejection', { error: reason instanceof Error ? reason : String(reason) });
  });
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception, exiting', { error: err });
    process.exit(1);
  });
  return null;
}

main().then(
  (code) => {
    if (code !== null) process.exit(code);
  },
  (err) => {
    log.error(`easy-mxl failed to start: ${err && err.message ? err.message : err}`);
    process.exit(1);
  },
);
