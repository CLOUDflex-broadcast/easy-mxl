/**
 * Minimal leveled logger. Writes single-line entries to stderr so stdout stays
 * clean for the CLI. Levels: debug < info < warn < error.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

let currentLevel = LEVELS.info;

/**
 * @param {'debug'|'info'|'warn'|'error'|'silent'} level
 */
export function setLogLevel(level: LogLevel): void {
  if (!(level in LEVELS)) throw new Error(`Unknown log level: ${level}`);
  currentLevel = LEVELS[level];
}

export function getLogLevel(): LogLevel {
  return (Object.keys(LEVELS) as LogLevel[]).find((key) => LEVELS[key] === currentLevel) || 'info';
}

function write(level: LogLevel, msg: string, meta?: unknown): void {
  if (LEVELS[level] < currentLevel) return;
  const ts = new Date().toISOString();
  let line = `${ts} ${level.toUpperCase().padEnd(5)} ${msg}`;
  if (meta !== undefined) {
    try {
      line += ' ' + (typeof meta === 'string' ? meta : JSON.stringify(meta, replacer));
    } catch {
      line += ' [unserialisable meta]';
    }
  }
  process.stderr.write(line + '\n');
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    const error = value as Error & { code?: unknown; status?: unknown };
    return { name: error.name, message: error.message, code: error.code, status: error.status };
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export const log = {
  debug: (msg: string, meta?: unknown) => write('debug', msg, meta),
  info: (msg: string, meta?: unknown) => write('info', msg, meta),
  warn: (msg: string, meta?: unknown) => write('warn', msg, meta),
  error: (msg: string, meta?: unknown) => write('error', msg, meta),
};

export default log;
