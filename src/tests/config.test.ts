import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, defaultConfig, readConfig, saveConfig, validateConfig, validateContentUrl } from '../config.js';
import { createSecrets, verifyPassword } from '../auth.js';

test('URL-Policy und Single-Konfiguration', () => {
  assert.equal(validateContentUrl('https://example.com/game'), 'https://example.com/game');
  assert.equal(validateContentUrl('http://localhost:8000/'), 'http://localhost:8000/');
  for (const url of ['http://example.com/', 'file:///etc/passwd', 'https://user:pass@example.com/', 'https://example.com/#token']) {
    assert.throws(() => validateContentUrl(url));
  }
  assert.throws(() => validateConfig({ ...defaultConfig, mode: 'span' }));
  assert.throws(() => validateConfig({ ...defaultConfig, outputId: '; rm -rf /' }));
});

test('atomare Konfiguration, Revision und Backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'screenable-config-'));
  try {
    const path = join(dir, 'config.json');
    atomicWrite(path, JSON.stringify(defaultConfig));
    const next = saveConfig(path, { ...defaultConfig, contentUrl: 'https://example.com/' }, 0);
    assert.equal(next.revision, 1);
    assert.equal(readConfig(path).contentUrl, 'https://example.com/');
    assert.equal(JSON.parse(readFileSync(`${path}.bak`, 'utf8')).revision, 0);
    assert.throws(() => saveConfig(path, defaultConfig, 0));
    assert.equal(readConfig(path).revision, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Passwort wird mit scrypt geprüft', () => {
  const secrets = createSecrets('LangesSicheresPasswort123!');
  assert.notEqual(secrets.passwordHash, 'LangesSicheresPasswort123!');
  assert.equal(verifyPassword('LangesSicheresPasswort123!', secrets), true);
  assert.equal(verifyPassword('falsch', secrets), false);
  assert.throws(() => createSecrets('kurz'));
});
