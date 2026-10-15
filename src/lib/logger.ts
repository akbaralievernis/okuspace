export const logLevels = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof logLevels)[number];

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|service[-_]?role|session|credential|private[-_]?key/i;
export const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;

/** Глубокая копия с заменой значений чувствительных ключей. Безопасна для циклических ссылок. */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[MaxDepth]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Error) {
    return { name: value.name, message: value.message, ...(value.cause !== undefined ? { cause: redact(value.cause, depth + 1, seen) } : {}) };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, seen));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(item, depth + 1, seen);
  }
  return out;
}

export interface Logger {
  debug(msg: string, context?: Record<string, unknown>): void;
  info(msg: string, context?: Record<string, unknown>): void;
  warn(msg: string, context?: Record<string, unknown>): void;
  error(msg: string, context?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

type Sink = (level: LogLevel, line: string) => void;

const defaultSink: Sink = (level, line) => {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

export function createLogger(options?: { level?: LogLevel; bindings?: Record<string, unknown>; sink?: Sink }): Logger {
  const minLevel = logLevels.indexOf(options?.level ?? 'info');
  const bindings = options?.bindings ?? {};
  const sink = options?.sink ?? defaultSink;

  const write = (level: LogLevel, msg: string, context?: Record<string, unknown>) => {
    if (logLevels.indexOf(level) < minLevel) return;
    const entry = redact({ ...bindings, ...context }) as Record<string, unknown>;
    sink(level, JSON.stringify({ level, time: new Date().toISOString(), msg, ...entry }));
  };

  return {
    debug: (msg, ctx) => write('debug', msg, ctx),
    info: (msg, ctx) => write('info', msg, ctx),
    warn: (msg, ctx) => write('warn', msg, ctx),
    error: (msg, ctx) => write('error', msg, ctx),
    child: (extra) => createLogger({ level: logLevels[minLevel], bindings: { ...bindings, ...extra }, sink }),
  };
}

function envLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL;
  return (logLevels as readonly string[]).includes(raw ?? '') ? (raw as LogLevel) : 'info';
}

export const logger = createLogger({ level: envLevel() });
