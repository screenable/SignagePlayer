import { readFileSync } from 'node:fs';

type Level = 'error' | 'warn' | 'info';

// journald wertet ein vorangestelltes <N> als Syslog-Priorität aus, sodass
// `journalctl -p warning` Fehler und Warnungen gezielt filtern kann.
const priority: Record<Level, number> = { error: 3, warn: 4, info: 6 };
const journal = !!process.env.JOURNAL_STREAM;

export const version = (() => {
  try { return String((JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }).version || 'unknown'); }
  catch { return 'unknown'; }
})();

export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, event, ...fields });
  (level === 'info' ? process.stdout : process.stderr).write(`${journal ? `<${priority[level]}>` : ''}${line}\n`);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
