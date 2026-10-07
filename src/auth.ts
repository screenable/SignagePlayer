import { randomBytes, scrypt, scryptSync, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { atomicWrite } from './config.js';

type ScryptParams = { N: number; r: number; p: number };
export type Secrets = { salt: string; passwordHash: string; scrypt?: ScryptParams };

// OWASP-äquivalente scrypt-Parameter (N=2^15, r=8, p=3): rund 32 MiB und einige
// hundert Millisekunden pro Prüfung. Ältere Secrets ohne `scrypt` nutzen die
// Node-Standardwerte, mit denen sie erzeugt wurden.
const currentParams: ScryptParams = { N: 32768, r: 8, p: 3 };
const legacyParams: ScryptParams = { N: 16384, r: 8, p: 1 };
export const minPasswordLength = 12;

function options(params: ScryptParams): ScryptOptions {
  return { ...params, maxmem: 128 * params.N * params.r * 2 };
}

export function createSecrets(password: string): Secrets {
  if (password.length < minPasswordLength) throw new Error(`Passwort braucht mindestens ${minPasswordLength} Zeichen.`);
  const salt = randomBytes(32).toString('hex');
  return { salt, passwordHash: scryptSync(password, salt, 64, options(currentParams)).toString('hex'), scrypt: currentParams };
}

export function verifyPassword(password: string, secrets: Secrets): Promise<boolean> {
  const expected = Buffer.from(secrets.passwordHash, 'hex');
  return new Promise((resolve, reject) => {
    scrypt(password, secrets.salt, expected.length, options(secrets.scrypt || legacyParams), (error, actual) => {
      if (error) reject(error);
      else resolve(expected.length === actual.length && timingSafeEqual(expected, actual));
    });
  });
}

export function readSecrets(path: string): Secrets {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Secrets;
  if (typeof value?.salt !== 'string' || typeof value?.passwordHash !== 'string' || !/^([0-9a-f]{2})+$/.test(value.passwordHash)) {
    throw new Error('Ungültige Secrets-Datei.');
  }
  const params = value.scrypt;
  if (params !== undefined && ![params?.N, params?.r, params?.p].every(n => Number.isSafeInteger(n) && n > 0)) {
    throw new Error('Ungültige scrypt-Parameter in der Secrets-Datei.');
  }
  return value;
}

export function saveSecrets(path: string, secrets: Secrets): void {
  atomicWrite(path, JSON.stringify(secrets) + '\n', 0o600);
}
