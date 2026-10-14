import { readFileSync } from 'node:fs';

export type UpdateState = 'idle' | 'checking' | 'up_to_date' | 'available' | 'installing' | 'installed' | 'failed';
export type Release = { version: string; name: string | null; publishedAt: string | null; notes: string | null; url: string | null };
export type UpdateStatus = {
  state: UpdateState;
  currentVersion: string;
  latest: Release | null;
  checkedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  // Letzte Zeilen der Installerausgabe für das Dashboard.
  log: string[];
  requestId: string | null;
  updatedAt: string;
};
export type UpdateRequest = { id: string; action: 'check' | 'install'; createdAt: number };

export const REQUEST_MAX_AGE_MS = 5 * 60_000;

// Versionen wie v1.2.3 oder 1.2.3; Zusätze wie -rc1 werden ignoriert.
export function parseVersion(value: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  return match ? match.slice(1).map(Number) : null;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; }
}

export function readUpdateRequest(path: string): UpdateRequest | null {
  const request = readJson<Partial<UpdateRequest>>(path);
  if (!request || typeof request.id !== 'string' || !/^[0-9a-f-]{36}$/.test(request.id)) return null;
  if (request.action !== 'check' && request.action !== 'install') return null;
  if (typeof request.createdAt !== 'number') return null;
  return request as UpdateRequest;
}
