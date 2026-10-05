import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { atomicWrite, readConfig, type Config } from './config.js';
import { commandPath, configPath, runDir, stateDir, statusPath } from './paths.js';

const exec = promisify(execFile);
type Display = { id: string; primary: boolean; geometry: string | null };
type State = 'waiting_for_url' | 'waiting_for_display' | 'running' | 'restarting' | 'error';
let config: Config | null = null;
let browser: ChildProcess | null = null;
let selectedOutput: string | null = null;
let displays: Display[] = [];
let state: State = 'waiting_for_url';
let lastError: string | null = null;
let lastCommand: string | null = null;
let restartAt = 0;
let rapidRestarts = 0;
let lastLaunch = 0;
let network: 'unknown' | 'online' | 'offline' = 'unknown';
let shuttingDown = false;

if (!process.env.DISPLAY) throw new Error('DISPLAY fehlt; Player muss in einer X11-Session laufen.');
mkdirSync(runDir, { recursive: true });

function report(): void {
  atomicWrite(statusPath, JSON.stringify({
    state, browserPid: browser?.pid || null, contentUrl: config?.contentUrl || null,
    outputId: selectedOutput, displays, network, rapidRestarts, lastError,
    updatedAt: new Date().toISOString(),
  }) + '\n');
}

async function detectDisplays(): Promise<Display[]> {
  const { stdout } = await exec('xrandr', ['--query'], { timeout: 5000 });
  return stdout.split('\n').flatMap(line => {
    const match = line.match(/^(\S+) connected( primary)?(?: (\d+x\d+\+\d+\+\d+))?/);
    return match ? [{ id: match[1], primary: !!match[2], geometry: match[3] || null }] : [];
  });
}

async function setDisplayLayout(target: string, connected: Display[]): Promise<void> {
  const args: string[] = [];
  for (const display of connected) {
    args.push('--output', display.id);
    if (display.id === target) args.push('--primary', '--auto', '--pos', '0x0');
    else args.push('--off');
  }
  await exec('xrandr', args, { timeout: 8000 });
}

async function stopBrowser(): Promise<void> {
  const child = browser;
  browser = null;
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
  if (child.exitCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

async function focusBrowser(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const window = await browserWindow(pid);
      if (window) { await exec('xdotool', ['windowactivate', '--sync', window], { timeout: 3000 }); return; }
    } catch { /* Browserfenster noch nicht sichtbar. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  lastError = 'Browserfenster konnte nicht fokussiert werden.';
}

async function browserWindow(pid: number): Promise<string | null> {
  for (const args of [['search', '--onlyvisible', '--pid', String(pid)], ['search', '--onlyvisible', '--class', 'Chromium']]) {
    try {
      const { stdout } = await exec('xdotool', args, { timeout: 3000 });
      const window = stdout.trim().split('\n').at(-1);
      if (window) return window;
    } catch { /* Nächste Suchmethode. */ }
  }
  return null;
}

async function launchBrowser(next: Config): Promise<void> {
  displays = await detectDisplays();
  selectedOutput = next.outputId || displays.find(d => d.primary)?.id || displays[0]?.id || null;
  if (!selectedOutput || !displays.some(d => d.id === selectedOutput)) {
    state = 'waiting_for_display';
    lastError = `HDMI-Ausgang ${next.outputId || '(automatisch)'} nicht verfügbar.`;
    report(); return;
  }
  await setDisplayLayout(selectedOutput, displays);
  displays = await detectDisplays();
  const profile = join(stateDir, 'profiles', 'single');
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const chromium = process.env.SCREENABLE_CHROMIUM || 'chromium';
  const child = spawn(chromium, [
    '--kiosk', '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${profile}`,
    next.contentUrl!,
  ], { stdio: 'inherit', detached: true });
  browser = child;
  lastLaunch = Date.now();
  state = 'running';
  lastError = null;
  child.on('error', error => {
    if (browser !== child) return;
    browser = null;
    state = 'error';
    lastError = `Chromium konnte nicht gestartet werden: ${error.message}`;
    restartAt = Date.now() + 5000;
    report();
  });
  child.on('exit', (code, signal) => {
    if (browser !== child) return;
    browser = null;
    if (shuttingDown) return;
    if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Gruppe bereits beendet. */ } }
    rapidRestarts = Date.now() - lastLaunch > 60_000 ? 0 : rapidRestarts + 1;
    const delay = rapidRestarts > next.recovery.maxRapidRestarts ? 60 : next.recovery.browserRestartDelaySeconds;
    restartAt = Date.now() + delay * 1000;
    state = 'restarting';
    lastError = `Browser beendet (${signal || code}); Neustart in ${delay} s.`;
    console.warn(JSON.stringify({ event: 'browser_exit', code, signal, delay }));
    report();
  });
  console.info(JSON.stringify({ event: 'browser_started', pid: child.pid, outputId: selectedOutput }));
  report();
  if (child.pid) void focusBrowser(child.pid).then(report);
}

async function reloadBrowser(): Promise<void> {
  if (!browser?.pid) return;
  try {
    const window = await browserWindow(browser.pid);
    if (!window) throw new Error('Fenster nicht gefunden');
    await exec('xdotool', ['windowactivate', '--sync', window, 'key', '--clearmodifiers', 'ctrl+r'], { timeout: 3000 });
    console.info(JSON.stringify({ event: 'browser_reload' }));
  } catch {
    await stopBrowser();
    restartAt = 0;
    if (config?.contentUrl) await launchBrowser(config);
  }
}

async function checkNetwork(): Promise<void> {
  if (!config?.contentUrl) return;
  const hostname = new URL(config.contentUrl).hostname;
  if (['localhost', '127.0.0.1', '[::1]'].includes(hostname)) { network = 'online'; return; }
  const wasOffline = network === 'offline';
  try { await lookup(hostname); network = 'online'; }
  catch { network = 'offline'; }
  if (wasOffline && network === 'online' && browser) {
    console.info(JSON.stringify({ event: 'dns_recovered' }));
    await reloadBrowser();
  }
}

async function tick(): Promise<void> {
  const next = readConfig(configPath);
  if (!config || next.revision !== config.revision) {
    await stopBrowser();
    config = next;
    rapidRestarts = 0;
    restartAt = 0;
    state = next.contentUrl ? 'restarting' : 'waiting_for_url';
    if (next.contentUrl) await launchBrowser(next);
  }
  try {
    const command = JSON.parse(readFileSync(commandPath, 'utf8')) as { id: string; action: string; createdAt: number };
    if (command.id !== lastCommand) {
      lastCommand = command.id;
      if (Date.now() - command.createdAt < 60_000 && config?.contentUrl) {
        if (command.action === 'reload') await reloadBrowser();
        else if (command.action === 'restart') { await stopBrowser(); await launchBrowser(config); }
      }
    }
  } catch { /* Noch kein Kommando. */ }
  if (config?.contentUrl && !browser && Date.now() >= restartAt) await launchBrowser(config);
  report();
}

let busy = false;
setInterval(() => {
  if (busy || shuttingDown) return;
  busy = true;
  tick().catch(error => {
    state = 'error'; lastError = String(error);
    console.error(JSON.stringify({ event: 'player_error', error: String(error) }));
    report();
  }).finally(() => { busy = false; });
}, 2000);
setInterval(() => {
  if (shuttingDown || busy) return;
  busy = true;
  void checkNetwork().catch(() => {}).finally(() => { busy = false; });
}, 15_000);
void tick().catch(error => { console.error(error); process.exit(1); });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { shuttingDown = true; void stopBrowser().finally(() => process.exit(0)); });
}
