import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Config = {
  schemaVersion: 1;
  revision: number;
  mode: 'single';
  outputId: string | null;
  contentUrl: string | null;
  recovery: { browserRestartDelaySeconds: number; maxRapidRestarts: number };
};

export const defaultConfig: Config = {
  schemaVersion: 1,
  revision: 0,
  mode: 'single',
  outputId: null,
  contentUrl: null,
  recovery: { browserRestartDelaySeconds: 5, maxRapidRestarts: 5 },
};

export class ValidationError extends Error {}
export class ConflictError extends Error {}

export function validateConfig(value: unknown): Config {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Konfiguration muss ein Objekt sein.');
  const c = value as Record<string, unknown>;
  if (c.schemaVersion !== 1) throw new ValidationError('Unbekannte Schema-Version.');
  if (!Number.isSafeInteger(c.revision) || (c.revision as number) < 0) throw new ValidationError('Ungültige Revision.');
  if (c.mode !== 'single') throw new ValidationError('Der Prototyp unterstützt nur Single.');
  if (c.outputId !== null && (typeof c.outputId !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(c.outputId))) {
    throw new ValidationError('Ungültiger Display-Ausgang.');
  }
  if (c.contentUrl !== null) validateContentUrl(c.contentUrl);
  if (!c.recovery || typeof c.recovery !== 'object' || Array.isArray(c.recovery)) throw new ValidationError('Recovery-Einstellungen fehlen.');
  const recovery = c.recovery as Record<string, unknown>;
  const delay = recovery.browserRestartDelaySeconds;
  const max = recovery.maxRapidRestarts;
  if (!Number.isInteger(delay) || (delay as number) < 1 || (delay as number) > 60) throw new ValidationError('Ungültige Neustartverzögerung.');
  if (!Number.isInteger(max) || (max as number) < 1 || (max as number) > 20) throw new ValidationError('Ungültige Neustartgrenze.');
  return {
    schemaVersion: 1, revision: c.revision as number, mode: 'single',
    outputId: c.outputId as string | null, contentUrl: c.contentUrl as string | null,
    recovery: { browserRestartDelaySeconds: delay as number, maxRapidRestarts: max as number },
  };
}

export function validateContentUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new ValidationError('Bitte eine gültige URL eingeben.');
  let url: URL;
  try { url = new URL(value); } catch { throw new ValidationError('Bitte eine gültige URL eingeben.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new ValidationError('Nur HTTPS ist erlaubt; HTTP nur für localhost.');
  if (!url.hostname || url.username || url.password || url.hash) throw new ValidationError('URL ohne Zugangsdaten und Fragment eingeben.');
  return url.toString();
}

export function atomicWrite(path: string, content: string, mode = 0o640): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  const fd = openSync(tmp, 'wx', mode);
  try {
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  const dir = openSync(dirname(path), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

export function readConfig(path: string): Config {
  return validateConfig(JSON.parse(readFileSync(path, 'utf8')));
}

export function saveConfig(path: string, input: unknown, expectedRevision: number): Config {
  const current = readConfig(path);
  if (current.revision !== expectedRevision) throw new ConflictError('Konfiguration wurde inzwischen geändert. Bitte neu laden.');
  const validated = validateConfig({ ...(input as object), revision: current.revision + 1 });
  if (existsSync(path)) atomicWrite(`${path}.bak`, JSON.stringify(current, null, 2) + '\n');
  atomicWrite(path, JSON.stringify(validated, null, 2) + '\n');
  return validated;
}
