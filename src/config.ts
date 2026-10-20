import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Drehung des Bildes wie bei `xrandr --rotate`: normal und inverted sind Querformat,
// left (90° gegen den Uhrzeigersinn) und right (90° im Uhrzeigersinn) Hochformat.
export const orientations = ['normal', 'inverted', 'left', 'right'] as const;
export type Orientation = typeof orientations[number];
const MAX_ORIENTATIONS = 16;
// Feste Auflösungen je Ausgang (`xrandr --mode`); ohne Eintrag gilt der bevorzugte Modus des Bildschirms.
export const resolutions = ['1280x720', '1920x1080', '3840x2160'] as const;
export type Resolution = typeof resolutions[number];
const outputPattern = /^[A-Za-z0-9_.-]{1,64}$/;

export type Config = {
  schemaVersion: 1;
  revision: number;
  mode: 'single';
  outputId: string | null;
  contentUrl: string | null;
  // Ausrichtung je HDMI-Ausgang; fehlende Ausgänge laufen im Querformat.
  orientations: Record<string, Orientation>;
  // Auflösung je HDMI-Ausgang; fehlende Ausgänge nutzen den bevorzugten Modus.
  resolutions: Record<string, Resolution>;
  // Lautstärke des HDMI-Tons in Prozent; 0 schaltet stumm.
  volume: number;
  recovery: { browserRestartDelaySeconds: number; maxRapidRestarts: number };
};

export const defaultConfig: Config = {
  schemaVersion: 1,
  revision: 0,
  mode: 'single',
  outputId: null,
  contentUrl: null,
  orientations: {},
  resolutions: {},
  volume: 100,
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
  if (c.outputId !== null && (typeof c.outputId !== 'string' || !outputPattern.test(c.outputId))) {
    throw new ValidationError('Ungültiger Display-Ausgang.');
  }
  if (c.contentUrl !== null) validateContentUrl(c.contentUrl);
  const orientationMap = validateOrientations(c.orientations);
  const resolutionMap = validateResolutions(c.resolutions);
  // Ältere Konfigurationen ohne Lautstärke spielen wie bisher mit 100 %.
  const volume = c.volume === undefined ? 100 : c.volume;
  if (!Number.isInteger(volume) || (volume as number) < 0 || (volume as number) > 100) throw new ValidationError('Lautstärke muss zwischen 0 und 100 liegen.');
  if (!c.recovery || typeof c.recovery !== 'object' || Array.isArray(c.recovery)) throw new ValidationError('Recovery-Einstellungen fehlen.');
  const recovery = c.recovery as Record<string, unknown>;
  const delay = recovery.browserRestartDelaySeconds;
  const max = recovery.maxRapidRestarts;
  if (!Number.isInteger(delay) || (delay as number) < 1 || (delay as number) > 60) throw new ValidationError('Ungültige Neustartverzögerung.');
  if (!Number.isInteger(max) || (max as number) < 1 || (max as number) > 20) throw new ValidationError('Ungültige Neustartgrenze.');
  return {
    schemaVersion: 1, revision: c.revision as number, mode: 'single',
    outputId: c.outputId as string | null, contentUrl: c.contentUrl as string | null, orientations: orientationMap, resolutions: resolutionMap, volume: volume as number,
    recovery: { browserRestartDelaySeconds: delay as number, maxRapidRestarts: max as number },
  };
}

// Ältere Konfigurationen ohne das Feld bleiben gültig. Querformat wird nicht
// gespeichert, damit die Datei nur Abweichungen enthält.
function validateOrientations(value: unknown): Record<string, Orientation> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Ungültige Ausrichtungen.');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_ORIENTATIONS) throw new ValidationError('Zu viele Ausrichtungen.');
  const result: Record<string, Orientation> = {};
  for (const [output, orientation] of entries) {
    if (!outputPattern.test(output)) throw new ValidationError('Ungültiger Display-Ausgang in den Ausrichtungen.');
    if (!orientations.includes(orientation as Orientation)) throw new ValidationError(`Ungültige Ausrichtung für ${output}.`);
    if (orientation !== 'normal') result[output] = orientation as Orientation;
  }
  return result;
}

// Wie bei den Ausrichtungen: ältere Konfigurationen ohne das Feld bleiben gültig.
function validateResolutions(value: unknown): Record<string, Resolution> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Ungültige Auflösungen.');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_ORIENTATIONS) throw new ValidationError('Zu viele Auflösungen.');
  const result: Record<string, Resolution> = {};
  for (const [output, resolution] of entries) {
    if (!outputPattern.test(output)) throw new ValidationError('Ungültiger Display-Ausgang in den Auflösungen.');
    if (!resolutions.includes(resolution as Resolution)) throw new ValidationError(`Ungültige Auflösung für ${output}.`);
    result[output] = resolution as Resolution;
  }
  return result;
}

export function resolutionFor(config: Config, output: string): Resolution | null {
  return Object.hasOwn(config.resolutions, output) ? config.resolutions[output] : null;
}

export function orientationFor(config: Config, output: string): Orientation {
  return Object.hasOwn(config.orientations, output) ? config.orientations[output] : 'normal';
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
