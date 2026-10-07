import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, defaultConfig } from '../config.js';

type Status = { browserPid: number | null; state: string; lastError: string | null; displays: { id: string }[] };
const connectedOn = 'HDMI-1 connected primary 1920x1080+0+0 (normal left inverted right x axis y axis) 527mm x 296mm';
const connectedOff = 'HDMI-1 connected (normal left inverted right x axis y axis)';

async function waitFor<T>(read: () => T | null | undefined | false, timeout = 15_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const value = read(); if (value) return value; } catch { /* Noch nicht bereit. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Zeitüberschreitung beim Warten auf den Player.');
}

function startPlayer(prepare?: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'screenable-player-'));
  const bin = join(dir, 'bin');
  const runtime = join(dir, 'run');
  mkdirSync(bin); mkdirSync(runtime);
  const script = (name: string, code: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${code}\n`); chmodSync(path, 0o755);
  };
  // Fake-xrandr: liest den Anzeigezustand aus einer Datei; Layout-Aufrufe schalten den Ausgang ein.
  writeFileSync(join(dir, 'xrandr.txt'), `${connectedOn}\n`);
  script('xrandr', `case "$1" in
  --query|--current) cat "${dir}/xrandr.txt" ;;
  *) echo "$*" >> "${dir}/xrandr.log"; echo "${connectedOn}" > "${dir}/xrandr.txt" ;;
esac`);
  script('xdotool', 'exit 1');
  script('chromium', `printf '%s\\n' "$@" > "${dir}/chromium-args"; exec sleep 100`);
  atomicWrite(join(dir, 'config.json'), JSON.stringify({ ...defaultConfig, contentUrl: 'https://example.com/', recovery: { browserRestartDelaySeconds: 1, maxRapidRestarts: 5 } }));
  prepare?.(dir);
  const child = spawn(process.execPath, ['dist/player.js'], {
    cwd: process.cwd(), stdio: 'ignore',
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, DISPLAY: ':99', SCREENABLE_STATE_DIR: dir, SCREENABLE_RUN_DIR: runtime,
      SCREENABLE_DISPLAY_CHECK_MS: '200', SCREENABLE_CHROMIUM_FLAGS: '--enable-features=TestFeature',
    },
  });
  const status = () => JSON.parse(readFileSync(join(runtime, 'status.json'), 'utf8')) as Status;
  const running = (other?: number) => waitFor(() => {
    const s = status();
    return s.state === 'running' && s.browserPid && s.browserPid !== other ? s.browserPid : null;
  });
  const stop = async () => {
    child.kill('SIGTERM');
    const [code] = await once(child, 'exit');
    rmSync(dir, { recursive: true, force: true });
    return code as number | null;
  };
  return { dir, runtime, status, running, stop };
}

test('Single-Player startet Chromium und erholt sich nach Prozessabsturz', { timeout: 30_000 }, async () => {
  const player = startPlayer();
  try {
    const first = await player.running();
    const args = readFileSync(join(player.dir, 'chromium-args'), 'utf8').split('\n');
    for (const flag of ['--kiosk', '--hide-crash-restore-bubble', '--noerrdialogs', '--enable-features=TestFeature']) assert.ok(args.includes(flag), flag);
    assert.equal(args.filter(Boolean).at(-1), 'https://example.com/');
    process.kill(first, 'SIGKILL');
    const second = await player.running(first);
    assert.notEqual(second, first);
  } finally { assert.equal(await player.stop(), 0); }
});

test('Verwaiste Profilsperre und Absturzmarkierung werden vor dem Start bereinigt', { timeout: 30_000 }, async () => {
  const player = startPlayer(dir => {
    const profile = join(dir, 'profiles', 'single');
    mkdirSync(join(profile, 'Default'), { recursive: true });
    symlinkSync('anderes-geraet-4242', join(profile, 'SingletonLock'));
    writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({ profile: { exit_type: 'Crashed', exited_cleanly: false, name: 'Kiosk' } }));
  });
  try {
    await player.running();
    const profile = join(player.dir, 'profiles', 'single');
    assert.equal(existsSync(join(profile, 'SingletonLock')), false);
    const prefs = JSON.parse(readFileSync(join(profile, 'Default', 'Preferences'), 'utf8'));
    assert.deepEqual(prefs.profile, { exit_type: 'Normal', exited_cleanly: true, name: 'Kiosk' });
  } finally { await player.stop(); }
});

test('Neue Revision und Neustart-Kommando starten den Browser neu', { timeout: 30_000 }, async () => {
  const player = startPlayer();
  try {
    const first = await player.running();
    atomicWrite(join(player.dir, 'config.json'), JSON.stringify({ ...defaultConfig, revision: 1, contentUrl: 'https://example.com/neu', recovery: { browserRestartDelaySeconds: 1, maxRapidRestarts: 5 } }));
    const second = await player.running(first);
    assert.match(readFileSync(join(player.dir, 'chromium-args'), 'utf8'), /https:\/\/example\.com\/neu/);
    atomicWrite(join(player.runtime, 'command.json'), JSON.stringify({ id: 'cmd-1', action: 'restart', createdAt: Date.now() }));
    const third = await player.running(second);
    assert.notEqual(third, second);
  } finally { await player.stop(); }
});

test('Hotplug: abgeschalteter Ausgang wird nach Entprellung neu gesetzt', { timeout: 30_000 }, async () => {
  const player = startPlayer();
  try {
    const first = await player.running();
    // Monitor getrennt: Browser läuft weiter, Status meldet den Verlust.
    writeFileSync(join(player.dir, 'xrandr.txt'), 'HDMI-1 disconnected (normal left inverted right x axis y axis)\n');
    await waitFor(() => player.status().lastError?.includes('getrennt'));
    assert.equal(player.status().browserPid, first);
    // Monitor zurück, aber vom X-Server ohne Modus: Layout neu setzen und Browser neu starten.
    writeFileSync(join(player.dir, 'xrandr.txt'), `${connectedOff}\n`);
    const second = await player.running(first);
    assert.notEqual(second, first);
    const calls = readFileSync(join(player.dir, 'xrandr.log'), 'utf8').trim().split('\n');
    assert.equal(calls.length, 2);
    assert.match(calls[1], /--output HDMI-1 --primary --auto --pos 0x0/);
    assert.equal(player.status().lastError, null);
  } finally { await player.stop(); }
});
