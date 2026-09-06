/**
 * Configuration from command-line flags and environment variables.
 *
 * Precedence: flag > environment variable > built-in default (DESIGN.md §3).
 * Flags accept both `--flag value` and `--flag=value`. Every value is validated
 * so the server never starts with a nonsensical port or mode.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LogLevel } from './log.js';

/** Repository root (the directory that holds package.json). */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const satisfies readonly LogLevel[];
const MAX_ID = 0xfffffffe; // largest uid/gid Linux accepts (0xffffffff is "unchanged")

export interface Config {
  host: string;
  port: number;
  domainRoot: string;
  dockerHost: string | null;
  token: string | null;
  catalogPaths: string[];
  allowedOrigins: string[];
  domainUid: number;
  domainGid: number;
  domainMode: number;
  logLevel: LogLevel;
  publicDir: string;
  repoRoot: string;
  version: string;
  help: boolean;
  showVersion: boolean;
}

interface OptionDefinition {
  flag: string;
  alias?: string;
  key: string;
  env?: string;
  kind: 'string' | 'list' | 'boolean';
  arg?: string;
  help: string;
}

/**
 * Option table: flag name → { key, env, kind, describe }.
 * `kind` is `'string'`, `'list'` (repeatable) or `'boolean'`.
 */
const OPTIONS: OptionDefinition[] = [
  { flag: '--host', key: 'host', env: 'EASY_MXL_HOST', kind: 'string', arg: '<ip>', help: 'bind address (default 127.0.0.1)' },
  { flag: '--port', key: 'port', env: 'EASY_MXL_PORT', kind: 'string', arg: '<n>', help: 'TCP port (default 9700)' },
  { flag: '--domain-root', key: 'domainRoot', env: 'EASY_MXL_DOMAIN_ROOT', kind: 'string', arg: '<dir>', help: 'tmpfs directory holding MXL domains (default /dev/shm/mxl)' },
  { flag: '--docker', key: 'dockerHost', env: 'DOCKER_HOST', kind: 'string', arg: '<url>', help: 'Docker endpoint, unix:///path or tcp://host:port (default /var/run/docker.sock)' },
  { flag: '--token', key: 'token', env: 'EASY_MXL_TOKEN', kind: 'string', arg: '<secret>', help: 'require this token on /api and /ws (default: no auth)' },
  { flag: '--catalog', key: 'catalogPaths', env: 'EASY_MXL_CATALOG', kind: 'list', arg: '<file>', help: 'extra app catalog JSON (repeatable; env is ":"-separated)' },
  { flag: '--domain-uid', key: 'domainUid', env: 'EASY_MXL_DOMAIN_UID', kind: 'string', arg: '<n>', help: 'owner uid of new domains (default 1000)' },
  { flag: '--domain-gid', key: 'domainGid', env: 'EASY_MXL_DOMAIN_GID', kind: 'string', arg: '<n>', help: 'owner gid of new domains (default 1000)' },
  { flag: '--domain-mode', key: 'domainMode', env: 'EASY_MXL_DOMAIN_MODE', kind: 'string', arg: '<octal>', help: 'mode of new domains (default 0775)' },
  { flag: '--log-level', key: 'logLevel', env: 'EASY_MXL_LOG_LEVEL', kind: 'string', arg: '<level>', help: `${LOG_LEVELS.join('|')} (default info)` },
  { flag: '--allowed-origins', key: 'allowedOrigins', env: 'EASY_MXL_ALLOWED_ORIGINS', kind: 'list', arg: '<origin>', help: 'extra browser origins or host names allowed to use the API, e.g. https://ops.example.com (repeatable; env is ","-separated)' },
  { flag: '--help', alias: '-h', key: 'help', kind: 'boolean', help: 'show this help and exit' },
  { flag: '--version', key: 'showVersion', kind: 'boolean', help: 'print the version and exit' },
];

const BY_FLAG = new Map<string, OptionDefinition>();
for (const opt of OPTIONS) {
  BY_FLAG.set(opt.flag, opt);
  if (opt.alias) BY_FLAG.set(opt.alias, opt);
}

/**
 * Read the package version once; `'0.0.0'` when package.json is unreadable so
 * the tool still starts from an unusual layout.
 * @returns {string}
 */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Parse argv into `{ flags: Map<key, string>, lists: Map<key, string[]>, booleans: Set<key> }`.
 * @param {string[]} argv
 * @returns {{ values: Map<string, string>, lists: Map<string, string[]>, booleans: Set<string> }}
 * @throws {Error} on unknown options, missing values or stray positional arguments
 */
function parseArgv(argv: string[]): { values: Map<string, string>; lists: Map<string, string[]>; booleans: Set<string> } {
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const booleans = new Set<string>();
  const args = Array.isArray(argv) ? argv.map(String) : [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    let name = arg;
    let inlineValue;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) {
      name = arg.slice(0, eq);
      inlineValue = arg.slice(eq + 1);
    }
    const opt = BY_FLAG.get(name);
    if (!opt) throw new Error(`Unknown option: ${name}`);
    if (opt.kind === 'boolean') {
      if (inlineValue !== undefined) throw new Error(`Option ${name} does not take a value`);
      booleans.add(opt.key);
      continue;
    }
    let value = inlineValue;
    if (value === undefined) {
      if (i + 1 >= args.length) throw new Error(`Option ${name} requires a value`);
      value = args[++i];
    }
    if (opt.kind === 'list') {
      if (!lists.has(opt.key)) lists.set(opt.key, []);
      lists.get(opt.key).push(value);
    } else {
      values.set(opt.key, value);
    }
  }
  return { values, lists, booleans };
}

/**
 * Pick the raw string for an option: flag, then env, then `undefined`.
 * Empty environment values count as unset so `EASY_MXL_TOKEN=` means "no token".
 * @param {{ key: string, env?: string }} opt
 * @param {Map<string, string>} flags
 * @param {Record<string, string|undefined>} env
 * @returns {{ value: string|undefined, source: string }}
 */
function pick(opt: OptionDefinition, flags: Map<string, string>, env: Record<string, string | undefined>): { value: string | undefined; source: string } {
  if (flags.has(opt.key)) return { value: flags.get(opt.key), source: opt.flag };
  const raw = opt.env ? env[opt.env] : undefined;
  if (typeof raw === 'string' && raw.trim() !== '') return { value: raw.trim(), source: opt.env };
  return { value: undefined, source: opt.env || opt.flag };
}

/**
 * @param {string} source flag or env name for the error message
 * @param {string} value
 * @param {number} min
 * @param {number} max
 * @param {string} what
 * @returns {number}
 */
function parseInteger(source: string, value: string, min: number, max: number, what: string): number {
  const n = /^\s*-?\d+\s*$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid value for ${source}: "${value}" (expected ${what})`);
  }
  return n;
}

/**
 * Parse an octal mode such as `0775`, `775`, `1777` or `0o775`.
 * @param {string} source
 * @param {string} value
 * @returns {number}
 */
function parseMode(source: string, value: string): number {
  const text = value.trim().replace(/^0o/i, '');
  if (!/^[0-7]{3,4}$/.test(text)) {
    throw new Error(`Invalid value for ${source}: "${value}" (expected an octal mode such as 0775)`);
  }
  return Number.parseInt(text, 8);
}

/**
 * Build the configuration from argv and env.
 *
 * @param {string[]} [argv=process.argv.slice(2)]
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {Config}
 * @throws {Error} `Unknown option: …`, `Option … requires a value`, `Invalid value for …`
 */
export function loadConfig(argv: string[] = process.argv.slice(2), env: Record<string, string | undefined> = process.env): Config {
  const e = env && typeof env === 'object' ? env : {};
  const { values, lists, booleans } = parseArgv(argv);
  const opt = (key: string): OptionDefinition => OPTIONS.find((option) => option.key === key)!;

  const host = pick(opt('host'), values, e);
  const port = pick(opt('port'), values, e);
  const domainRoot = pick(opt('domainRoot'), values, e);
  const dockerHost = pick(opt('dockerHost'), values, e);
  const token = pick(opt('token'), values, e);
  const domainUid = pick(opt('domainUid'), values, e);
  const domainGid = pick(opt('domainGid'), values, e);
  const domainMode = pick(opt('domainMode'), values, e);
  const logLevel = pick(opt('logLevel'), values, e);

  const hostValue = host.value === undefined ? '127.0.0.1' : host.value.trim();
  if (!hostValue) throw new Error(`Invalid value for ${host.source}: host must not be empty`);

  const level = (logLevel.value === undefined ? 'info' : logLevel.value.trim().toLowerCase()) as LogLevel;
  if (!LOG_LEVELS.includes(level)) {
    throw new Error(`Invalid value for ${logLevel.source}: "${logLevel.value}" (expected ${LOG_LEVELS.join(', ')})`);
  }

  // Catalog: built-in first, then env extras, then flag extras (later files override by id).
  const catalogPaths = [path.join(REPO_ROOT, 'catalog', 'default.json')];
  const envCatalog = typeof e.EASY_MXL_CATALOG === 'string' ? e.EASY_MXL_CATALOG : '';
  for (const p of envCatalog.split(':')) {
    if (p.trim()) catalogPaths.push(path.resolve(p.trim()));
  }
  for (const p of lists.get('catalogPaths') || []) {
    if (!p.trim()) throw new Error('Option --catalog requires a file path');
    catalogPaths.push(path.resolve(p.trim()));
  }

  const allowedOrigins = [];
  const envOrigins = typeof e.EASY_MXL_ALLOWED_ORIGINS === 'string' ? e.EASY_MXL_ALLOWED_ORIGINS : '';
  for (const o of envOrigins.split(',')) {
    if (o.trim()) allowedOrigins.push(o.trim());
  }
  for (const o of lists.get('allowedOrigins') || []) {
    for (const part of o.split(',')) {
      if (part.trim()) allowedOrigins.push(part.trim());
    }
  }

  return {
    host: hostValue,
    port: port.value === undefined ? 9700 : parseInteger(port.source, port.value, 1, 65535, 'a port between 1 and 65535'),
    domainRoot: path.resolve(domainRoot.value === undefined ? '/dev/shm/mxl' : domainRoot.value.trim()),
    dockerHost: dockerHost.value === undefined ? null : dockerHost.value.trim(),
    token: token.value === undefined || token.value === '' ? null : token.value,
    catalogPaths: [...new Set(catalogPaths)],
    allowedOrigins: [...new Set(allowedOrigins)],
    domainUid: domainUid.value === undefined ? 1000 : parseInteger(domainUid.source, domainUid.value, 0, MAX_ID, 'a non-negative integer uid'),
    domainGid: domainGid.value === undefined ? 1000 : parseInteger(domainGid.source, domainGid.value, 0, MAX_ID, 'a non-negative integer gid'),
    domainMode: domainMode.value === undefined ? 0o775 : parseMode(domainMode.source, domainMode.value),
    logLevel: level,
    publicDir: path.join(REPO_ROOT, 'public'),
    repoRoot: REPO_ROOT,
    version: readVersion(),
    help: booleans.has('help'),
    showVersion: booleans.has('showVersion'),
  };
}

/**
 * Usage text for `--help`.
 * @returns {string}
 */
export function printHelp(): string {
  const rows = OPTIONS.map((o) => {
    const names = o.alias ? `${o.alias}, ${o.flag}` : o.flag;
    return [`${names}${o.arg ? ` ${o.arg}` : ''}`, o.help, o.env ? `env ${o.env}` : ''];
  });
  const width = Math.max(...rows.map((r) => r[0].length)) + 2;
  const lines = rows.map(([left, help, env]) => `  ${left.padEnd(width)}${help}${env ? `  [${env}]` : ''}`);
  return [
    `EASY MXL v${readVersion()} - manage DMF-MXL media-function containers and MXL domains`,
    '',
    'Usage: easy-mxl [options]',
    '',
    'Options (flags override environment variables, which override the defaults):',
    ...lines,
    '',
    'Examples:',
    '  easy-mxl                                   # http://127.0.0.1:9700, domains in /dev/shm/mxl',
    '  easy-mxl --host 0.0.0.0 --token s3cret     # reachable on the LAN, token required',
    '  easy-mxl --domain-root /Volumes/mxl        # share domains with the mxl-hands-on compose files',
    '  easy-mxl --catalog ./my-apps.json          # add or override catalog entries',
    '',
  ].join('\n');
}
