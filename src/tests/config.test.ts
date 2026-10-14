import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, defaultConfig, orientationFor, readConfig, saveConfig, validateConfig, validateContentUrl } from '../config.js';
import { createSecrets, readSecrets, saveSecrets, verifyPassword } from '../auth.js';

test('URL-Policy und Single-Konfiguration', () => {
  assert.equal(validateContentUrl('https://example.com/game'), 'https://example.com/game');
  assert.equal(validateContentUrl('http://localhost:8000/'), 'http://localhost:8000/');
  for (const url of ['http://example.com/', 'file:///etc/passwd', 'https://user:pass@example.com/', 'https://example.com/#token']) {
    assert.throws(() => validateContentUrl(url));
  }
  assert.throws(() => validateConfig({ ...defaultConfig, mode: 'span' }));
  assert.throws(() => validateConfig({ ...defaultConfig, outputId: '; rm -rf /' }));
});

test('Ausrichtung je Ausgang', () => {
  const config = validateConfig({ ...defaultConfig, orientations: { 'HDMI-1': 'left', 'HDMI-2': 'normal', 'DP-1': 'inverted' } });
  // Querformat ist der Standard und wird nicht gespeichert.
  assert.deepEqual(config.orientations, { 'HDMI-1': 'left', 'DP-1': 'inverted' });
  assert.equal(orientationFor(config, 'HDMI-1'), 'left');
  assert.equal(orientationFor(config, 'HDMI-2'), 'normal');
  assert.equal(orientationFor(config, 'constructor'), 'normal');
  // Konfigurationen älterer Versionen ohne das Feld bleiben gültig.
  const { orientations: _, ...legacy } = defaultConfig;
  assert.deepEqual(validateConfig(legacy).orientations, {});
  for (const orientations of [{ 'HDMI-1': 'diagonal' }, { '; rm -rf /': 'left' }, ['left'], 'left', Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`HDMI-${i}`, 'left']))]) {
    assert.throws(() => validateConfig({ ...defaultConfig, orientations }), JSON.stringify(orientations));
  }
});

test('Lautstärke', () => {
  assert.equal(validateConfig(defaultConfig).volume, 100);
  const { volume: _, ...legacy } = defaultConfig;
  assert.equal(validateConfig(legacy).volume, 100);
  assert.equal(validateConfig({ ...defaultConfig, volume: 0 }).volume, 0);
  for (const volume of [-1, 101, 50.5, '50', null]) assert.throws(() => validateConfig({ ...defaultConfig, volume }), String(volume));
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
    assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Passwort wird mit scrypt geprüft', async () => {
  const secrets = createSecrets('LangesSicheresPasswort123!');
  assert.notEqual(secrets.passwordHash, 'LangesSicheresPasswort123!');
  assert.deepEqual(secrets.scrypt, { N: 32768, r: 8, p: 3 });
  assert.equal(await verifyPassword('LangesSicheresPasswort123!', secrets), true);
  assert.equal(await verifyPassword('falsch', secrets), false);
  assert.throws(() => createSecrets('kurz'));
});

test('bestehende Secrets ohne scrypt-Parameter bleiben gültig', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'screenable-secrets-'));
  try {
    const path = join(dir, 'secrets.json');
    const salt = 'a'.repeat(64);
    writeFileSync(path, JSON.stringify({ salt, passwordHash: scryptSync('AltesPasswort123!', salt, 64).toString('hex') }));
    const legacy = readSecrets(path);
    assert.equal(await verifyPassword('AltesPasswort123!', legacy), true);
    assert.equal(await verifyPassword('AltesPasswort123?', legacy), false);
    saveSecrets(path, createSecrets('NeuesPasswort1234!'));
    assert.equal(await verifyPassword('NeuesPasswort1234!', readSecrets(path)), true);
    writeFileSync(path, JSON.stringify({ salt, passwordHash: 'kein-hex' }));
    assert.throws(() => readSecrets(path));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
