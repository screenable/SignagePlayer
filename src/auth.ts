import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { atomicWrite } from './config.js';

export type Secrets = { salt: string; passwordHash: string };

export function createSecrets(password: string): Secrets {
  if (password.length < 12) throw new Error('Passwort braucht mindestens 12 Zeichen.');
  const salt = randomBytes(32).toString('hex');
  return { salt, passwordHash: scryptSync(password, salt, 64).toString('hex') };
}

export function verifyPassword(password: string, secrets: Secrets): boolean {
  const expected = Buffer.from(secrets.passwordHash, 'hex');
  const actual = scryptSync(password, secrets.salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function readSecrets(path: string): Secrets {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Secrets;
  if (typeof value?.salt !== 'string' || typeof value?.passwordHash !== 'string') throw new Error('Ungültige Secrets-Datei.');
  return value;
}

export function saveSecrets(path: string, secrets: Secrets): void {
  atomicWrite(path, JSON.stringify(secrets) + '\n', 0o600);
}
