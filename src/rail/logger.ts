/**
 * Structured JSON logger for rail server.
 * Fly.io captures stdout automatically.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const minLevel: LogLevel = (process.env['LOG_LEVEL'] as LogLevel) || 'info';

export function log(level: LogLevel, component: string, message: string, data?: Record<string, unknown>): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    component,
    msg: message,
    ...data,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const railLog = {
  debug: (component: string, msg: string, data?: Record<string, unknown>) => log('debug', component, msg, data),
  info: (component: string, msg: string, data?: Record<string, unknown>) => log('info', component, msg, data),
  warn: (component: string, msg: string, data?: Record<string, unknown>) => log('warn', component, msg, data),
  error: (component: string, msg: string, data?: Record<string, unknown>) => log('error', component, msg, data),
};
