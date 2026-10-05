import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, readlinkSync, unlinkSync } from 'node:fs';
import { connect } from 'node:net';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { atomicWrite, readConfig, type Config } from './config.js';
import { errorText, log, version } from './log.js';
import { commandPath, configPath, runDir, stateDir, statusPath } from './paths.js';

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const TICK_MS = 2000;
const STATUS_MS = 2000;
const DISPLAY_CHECK_MS = Number(process.env.SCREENABLE_DISPLAY_CHECK_MS) || 10_000;
const NETWORK_CHECK_MS = Number(process.env.SCREENABLE_NETWORK_CHECK_MS) || 15_000;
const NETWORK_TIMEOUT_MS = 5000;
const WAIT_FOR_DISPLAY_MS = 5000;
const MAX_BACKOFF_SECONDS = 60;
const RAPID_RESTART_WINDOW_MS = 60_000;
const COMMAND_MAX_AGE_MS = 60_000;

type Display = { id: string; primary: boolean; geometry: string | null };
type State = 'waiting_for_url' | 'waiting_for_display' | 'running' | 'restarting' | 'error';
let config: Config | null = null;
let browser: ChildProcess | null = null;
let browserStartedAt: string | null = null;
let selectedOutput: string | null = null;
let activeLayout: string | null = null;
let pendingLayout: string | null = null;
let displayLost = false;
let displays: Display[] = [];
let state: State = 'waiting_for_url';
let lastError: string | null = null;
let lastCommand: string | null = null;
let restartAt = 0;
let rapidRestarts = 0;
let launchFailures = 0;
let lastLaunch = 0;
let nextDisplayCheck = 0;
let network: 'unknown' | 'online' | 'offline' = 'unknown';
let networkFailures = 0;
let reloadRequested = false;
let shuttingDown = false;

if (!process.env.DISPLAY) throw new Error('DISPLAY fehlt; Player muss in einer X11-Session laufen.');
try { mkdirSync(runDir, { recursive: true }); }
catch (error) { log('warn', 'run_dir_unavailable', { runDir, error: errorText(error) }); }

const chromium = process.env.SCREENABLE_CHROMIUM || 'chromium';
// Zusätzliche, am Gerät erprobte Flags (z. B. GPU) ohne Codeänderung, etwa per
// `systemctl --user edit screenable-player`. Nur `--`-Optionen, nie per Shell interpretiert.
const requestedFlags = (process.env.SCREENABLE_CHROMIUM_FLAGS || '').split(/\s+/).filter(Boolean);
const extraFlags = requestedFlags.filter(flag => flag.startsWith('--'));
if (extraFlags.length !== requestedFlags.length) {
  log('warn', 'chromium_flags_ignored', { flags: requestedFlags.filter(flag => !flag.startsWith('--')) });
}

// Wiederkehrende Fehler nur bei Änderung loggen, damit das Journal nicht alle zwei Sekunden wächst.
const reported = new Map<string, string>();
function problem(event: string, message: string | null, fields: Record<string, unknown> = {}): void {
  if (message === null) {
    if (reported.delete(event)) log('info', `${event}_resolved`);
    return;
  }
  if (reported.get(event) === message) return;
  reported.set(event, message);
  log('warn', event, { error: message, ...fields });
}

function report(): void {
  try {
    atomicWrite(statusPath, JSON.stringify({
      version, state, browserPid: browser?.pid || null, browserStartedAt, contentUrl: config?.contentUrl || null,
      outputId: selectedOutput, displays, network, rapidRestarts, lastError,
      updatedAt: new Date().toISOString(),
    }) + '\n');
    problem('status_write_failed', null);
  } catch (error) { problem('status_write_failed', errorText(error)); }
}

async function detectDisplays(probe: boolean): Promise<Display[]> {
  // `--query` tastet die Ausgänge neu ab und kann auf manchen Treibern kurz ruckeln;
  // für die regelmäßige Hotplug-Prüfung genügt der vom X-Server gemeldete Stand.
  const { stdout } = await exec('xrandr', [probe ? '--query' : '--current'], { timeout: 5000 });
  return stdout.split('\n').flatMap(line => {
    const match = line.match(/^(\S+) connected( primary)?(?: (\d+x\d+\+\d+\+\d+))?/);
    return match ? [{ id: match[1], primary: !!match[2], geometry: match[3] || null }] : [];
  });
}

function chooseOutput(next: Config, connected: Display[]): string | null {
  if (next.outputId) return connected.some(d => d.id === next.outputId) ? next.outputId : null;
  return connected.find(d => d.primary)?.id || connected[0]?.id || null;
}

function layoutKey(output: string, connected: Display[]): string {
  return `${output}@${connected.find(d => d.id === output)?.geometry || 'off'}`;
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

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function prepareProfile(profile: string): void {
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  // Chromium verweigert den Start, wenn die Profilsperre von einem anderen Hostnamen
  // stammt (umbenanntes oder geklontes Gerät). Nur dieser Prozess verwaltet das Profil.
  try {
    const owner = readlinkSync(join(profile, 'SingletonLock'));
    const separator = owner.lastIndexOf('-');
    const pid = Number(owner.slice(separator + 1));
    if (owner.slice(0, separator) !== hostname() || !Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) {
      for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        try { unlinkSync(join(profile, name)); } catch { /* Bereits entfernt. */ }
      }
      log('info', 'profile_lock_cleared');
    }
  } catch { /* Keine Sperre vorhanden. */ }
  // Nach Absturz oder Stromausfall keinen "Seiten wiederherstellen"-Hinweis zeigen.
  const preferences = join(profile, 'Default', 'Preferences');
  try {
    const prefs = JSON.parse(readFileSync(preferences, 'utf8')) as { profile?: Record<string, unknown> };
    if (prefs.profile && (prefs.profile.exit_type !== 'Normal' || prefs.profile.exited_cleanly !== true)) {
      prefs.profile.exit_type = 'Normal';
      prefs.profile.exited_cleanly = true;
      atomicWrite(preferences, JSON.stringify(prefs), 0o600);
    }
  } catch { /* Profil noch nicht angelegt. */ }
}

function chromiumArgs(profile: string, url: string): string[] {
  return [
    '--kiosk', '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${profile}`,
    // Kiosk-Betrieb: keine Fehlerdialoge, kein Wiederherstellen-Hinweis, kein
    // Schlüsselbund-Prompt und keine Gesten, die Zoom oder Zurück-Navigation auslösen.
    '--noerrdialogs', '--hide-crash-restore-bubble', '--password-store=basic',
    '--disable-pinch', '--overscroll-history-navigation=0',
    ...extraFlags,
    url,
  ];
}

async function stopBrowser(): Promise<void> {
  const child = browser;
  browser = null;
  browserStartedAt = null;
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  await Promise.race([exited, sleep(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
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

async function focusBrowser(child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    if (browser !== child || shuttingDown) return;
    try {
      const window = await browserWindow(child.pid!);
      if (window) { await exec('xdotool', ['windowactivate', '--sync', window], { timeout: 3000 }); return; }
    } catch { /* Browserfenster noch nicht sichtbar. */ }
    await sleep(500);
  }
  if (browser !== child) return;
  lastError = 'Browserfenster konnte nicht fokussiert werden.';
  log('warn', 'browser_focus_failed', { pid: child.pid });
}

function scheduleRetry(next: Config, reason: string): void {
  launchFailures++;
  const delay = Math.min(MAX_BACKOFF_SECONDS, next.recovery.browserRestartDelaySeconds * 2 ** (launchFailures - 1));
  restartAt = Date.now() + delay * 1000;
  state = 'error';
  lastError = `${reason}; neuer Versuch in ${delay} s.`;
  log('error', 'browser_launch_failed', { error: reason, delay, failures: launchFailures });
}

async function launchBrowser(next: Config): Promise<void> {
  displays = await detectDisplays(true);
  const output = chooseOutput(next, displays);
  if (!output) {
    selectedOutput = null;
    activeLayout = null;
    state = 'waiting_for_display';
    lastError = `HDMI-Ausgang ${next.outputId || '(automatisch)'} nicht verfügbar.`;
    restartAt = Date.now() + WAIT_FOR_DISPLAY_MS;
    problem('display_unavailable', lastError);
    return;
  }
  problem('display_unavailable', null);
  selectedOutput = output;
  await setDisplayLayout(output, displays);
  displays = await detectDisplays(false);
  activeLayout = layoutKey(output, displays);
  if (activeLayout.endsWith('@off')) log('warn', 'display_mode_missing', { outputId: output });
  pendingLayout = null;
  displayLost = false;
  nextDisplayCheck = Date.now() + DISPLAY_CHECK_MS;
  const profile = join(stateDir, 'profiles', 'single');
  prepareProfile(profile);
  if (shuttingDown) return;
  const child = spawn(chromium, chromiumArgs(profile, next.contentUrl!), { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
  browser = child;
  lastLaunch = Date.now();
  browserStartedAt = new Date(lastLaunch).toISOString();
  state = 'running';
  lastError = null;
  child.once('spawn', () => { launchFailures = 0; });
  child.on('error', error => {
    if (browser !== child) return;
    browser = null;
    browserStartedAt = null;
    scheduleRetry(next, `Chromium konnte nicht gestartet werden: ${error.message}`);
    report();
  });
  child.on('exit', (code, signal) => {
    if (browser !== child) return;
    browser = null;
    browserStartedAt = null;
    if (shuttingDown) return;
    if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Gruppe bereits beendet. */ } }
    rapidRestarts = Date.now() - lastLaunch > RAPID_RESTART_WINDOW_MS ? 0 : rapidRestarts + 1;
    const crashLoop = rapidRestarts > next.recovery.maxRapidRestarts;
    const delay = crashLoop ? MAX_BACKOFF_SECONDS : next.recovery.browserRestartDelaySeconds;
    restartAt = Date.now() + delay * 1000;
    state = crashLoop ? 'error' : 'restarting';
    lastError = `Browser beendet (${signal || code})${crashLoop ? ' – wiederholte Abstürze' : ''}; Neustart in ${delay} s.`;
    log(crashLoop ? 'error' : 'warn', 'browser_exit', { code, signal, delay, rapidRestarts });
    report();
  });
  log('info', 'browser_started', { pid: child.pid, outputId: output, layout: activeLayout });
  report();
  void focusBrowser(child);
}

async function reloadBrowser(): Promise<void> {
  const child = browser;
  if (!child?.pid) return;
  try {
    const window = await browserWindow(child.pid);
    if (!window) throw new Error('Fenster nicht gefunden');
    await exec('xdotool', ['windowactivate', '--sync', window, 'key', '--clearmodifiers', 'ctrl+r'], { timeout: 3000 });
    log('info', 'browser_reload');
  } catch (error) {
    log('warn', 'browser_reload_failed', { error: errorText(error) });
    await stopBrowser();
    restartAt = 0;
  }
}

async function checkDisplays(): Promise<void> {
  nextDisplayCheck = Date.now() + DISPLAY_CHECK_MS;
  let current: Display[];
  try { current = await detectDisplays(false); problem('display_check_failed', null); }
  catch (error) { problem('display_check_failed', errorText(error)); return; }
  displays = current;
  if (!browser || !config) return;
  const target = config.outputId || selectedOutput;
  if (!target || !current.some(d => d.id === target)) {
    // Ziel getrennt (z. B. Fernseher ausgeschaltet): Browser weiterlaufen lassen
    // und bei Rückkehr des Ausgangs prüfen, ob das Layout neu gesetzt werden muss.
    pendingLayout = null;
    if (!displayLost) {
      displayLost = true;
      lastError = `HDMI-Ausgang ${target || '(automatisch)'} getrennt; warte auf Wiederverbindung.`;
      log('warn', 'display_disconnected', { outputId: target });
    }
    return;
  }
  if (displayLost) {
    displayLost = false;
    lastError = null;
    log('info', 'display_reconnected', { outputId: target });
  }
  const layout = layoutKey(target, current);
  if (layout === activeLayout) { pendingLayout = null; return; }
  // Erst bei zwei gleichen Messungen reagieren, damit kurze Hotplug-Flanken
  // keine Neustartkaskade auslösen.
  if (pendingLayout !== layout) { pendingLayout = layout; return; }
  log('info', 'display_changed', { from: activeLayout, to: layout });
  pendingLayout = null;
  await stopBrowser();
  state = 'restarting';
  restartAt = 0;
}

async function handleCommand(): Promise<void> {
  let command: { id?: unknown; action?: unknown; createdAt?: unknown };
  try { command = JSON.parse(readFileSync(commandPath, 'utf8')) as typeof command; }
  catch { return; }
  if (typeof command.id !== 'string' || command.id === lastCommand) return;
  lastCommand = command.id;
  if (typeof command.createdAt !== 'number' || Date.now() - command.createdAt > COMMAND_MAX_AGE_MS || !config?.contentUrl) return;
  log('info', 'player_command', { action: command.action });
  if (command.action === 'reload') await reloadBrowser();
  else if (command.action === 'restart') {
    await stopBrowser();
    state = 'restarting';
    rapidRestarts = 0;
    launchFailures = 0;
    restartAt = 0;
  }
}

async function tick(): Promise<void> {
  let next: Config | null = null;
  try { next = readConfig(configPath); problem('config_read_failed', null); }
  catch (error) {
    // Mit der letzten gültigen Konfiguration weiterlaufen, statt die Anzeige zu stoppen.
    problem('config_read_failed', errorText(error));
    if (!config) { state = 'error'; lastError = `Konfiguration nicht lesbar: ${errorText(error)}`; return; }
  }
  if (next && (!config || next.revision !== config.revision)) {
    await stopBrowser();
    config = next;
    rapidRestarts = 0;
    launchFailures = 0;
    restartAt = 0;
    activeLayout = null;
    pendingLayout = null;
    state = next.contentUrl ? 'restarting' : 'waiting_for_url';
    lastError = null;
    log('info', 'config_applied', { revision: next.revision, outputId: next.outputId, hasContentUrl: !!next.contentUrl });
  }
  await handleCommand();
  if (reloadRequested) {
    reloadRequested = false;
    await reloadBrowser();
  }
  if (Date.now() >= nextDisplayCheck) await checkDisplays();
  if (config?.contentUrl && !browser && Date.now() >= restartAt && !shuttingDown) {
    try { await launchBrowser(config); }
    catch (error) { scheduleRetry(config, `Start fehlgeschlagen: ${errorText(error)}`); }
  }
}

function canConnect(url: URL): Promise<boolean> {
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  return new Promise(resolve => {
    const socket = connect({ host: url.hostname.replace(/^\[(.*)\]$/, '$1'), port });
    const finish = (ok: boolean) => { clearTimeout(timer); socket.destroy(); resolve(ok); };
    const timer = setTimeout(() => finish(false), NETWORK_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

// Prüft per TCP-Verbindungsaufbau, ob der Inhalteserver erreichbar ist. Ein reiner
// DNS-Lookup kann aus dem Cache gelingen, obwohl die Verbindung fehlt, und blockiert
// ohne Zeitlimit. Die Prüfung läuft unabhängig von der Steuerschleife.
async function checkNetwork(): Promise<void> {
  const url = config?.contentUrl ? new URL(config.contentUrl) : null;
  if (!url) { network = 'unknown'; networkFailures = 0; return; }
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) { network = 'online'; return; }
  if (await canConnect(url)) {
    const recovered = network === 'offline';
    network = 'online';
    networkFailures = 0;
    if (recovered) {
      log('info', 'network_recovered', { host: url.hostname });
      if (browser) reloadRequested = true;
    }
  } else if (++networkFailures >= 2 && network !== 'offline') {
    network = 'offline';
    log('warn', 'network_offline', { host: url.hostname });
  }
}

async function loop(): Promise<void> {
  while (!shuttingDown) {
    try { await tick(); problem('player_error', null); }
    catch (error) {
      state = 'error';
      lastError = errorText(error);
      problem('player_error', lastError);
    }
    report();
    await sleep(TICK_MS);
  }
}

let networkBusy = false;
function runNetworkCheck(): void {
  if (networkBusy || shuttingDown) return;
  networkBusy = true;
  checkNetwork().catch(() => {}).finally(() => { networkBusy = false; });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', 'player_stopping', { signal });
    void stopBrowser().finally(() => process.exit(0));
  });
}

log('info', 'player_starting', { version, display: process.env.DISPLAY, extraFlags });
// Der Status-Heartbeat läuft auch während langer Schritte (xrandr, Browserstart) weiter,
// damit die API den Player nicht fälschlich als offline meldet.
setInterval(report, STATUS_MS).unref();
setInterval(runNetworkCheck, NETWORK_CHECK_MS).unref();
setTimeout(runNetworkCheck, 3000).unref();
void loop();
