// Over-the-Air-Update, ausgeführt von screenable-update.service als root. Die
// Dashboard-API darf selbst nichts installieren; sie legt nur eine Anforderung
// (update-request.json) ab, die screenable-update.path an diesen Dienst weitergibt.
// Angenommen werden ausschließlich "nach Updates suchen" und "neuestes Release
// installieren", keine Versionen, URLs oder Optionen aus der Anforderung.
import { spawn } from 'node:child_process';
import { chownSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from './config.js';
import { errorText, log, version } from './log.js';
import { runDir, updateRequestPath, updateStatusPath } from './paths.js';
import { isNewer, readJson, readUpdateRequest, REQUEST_MAX_AGE_MS, type Release, type UpdateStatus } from './update.js';

const repo = process.env.SCREENABLE_REPO || 'screenable/SignagePlayer';
const githubApi = process.env.SCREENABLE_GITHUB_API || 'https://api.github.com';
const tokenFile = process.env.SCREENABLE_GITHUB_TOKEN_FILE || '/etc/screenable-player/github-token';
const appDir = fileURLToPath(new URL('..', import.meta.url));
const installer = process.env.SCREENABLE_INSTALLER || join(appDir, 'install.sh');
const LOG_LINES = 30;
const MAX_NOTES = 4000;
const CHECK_TIMEOUT_MS = 20_000;

const previous = readJson<UpdateStatus>(updateStatusPath);
const status: UpdateStatus = {
  state: 'idle', latest: null, checkedAt: null, startedAt: null, finishedAt: null, error: null, log: [], requestId: null,
  ...previous,
  // Die laufende Version ist maßgeblich, nicht die zuletzt gespeicherte.
  currentVersion: version, updatedAt: new Date().toISOString(),
};

function write(): void {
  status.updatedAt = new Date().toISOString();
  atomicWrite(updateStatusPath, JSON.stringify(status) + '\n', 0o640);
  // Für die API (Gruppe screenable) lesbar machen.
  if (process.getuid?.() === 0) chownSync(updateStatusPath, 0, statSync(runDir).gid);
}

function token(): string {
  try { return readFileSync(tokenFile, 'utf8').trim(); } catch { return ''; }
}

async function latestRelease(): Promise<Release> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': `screenable-player/${version}` };
  const secret = token();
  if (secret) headers.authorization = `Bearer ${secret}`;
  let response: Response;
  try { response = await fetch(`${githubApi}/repos/${repo}/releases/latest`, { headers, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) }); }
  catch (error) { throw new Error(`Update-Server nicht erreichbar: ${errorText(error)}`); }
  if (response.status === 404) throw new Error(secret ? 'Kein Release gefunden oder Token ohne Zugriff.' : 'Kein Release gefunden. Bei privatem Repository fehlt das GitHub-Token (siehe Betriebsanleitung).');
  if (response.status === 401 || response.status === 403) throw new Error(`GitHub verweigert den Zugriff (HTTP ${response.status}); Token prüfen.`);
  if (!response.ok) throw new Error(`GitHub antwortet mit HTTP ${response.status}.`);
  const data = await response.json() as Record<string, unknown>;
  const tag = typeof data.tag_name === 'string' ? data.tag_name : '';
  if (!/^v?\d+\.\d+\.\d+$/.test(tag)) throw new Error(`Unerwartete Release-Version: ${tag || 'leer'}.`);
  const string = (value: unknown) => typeof value === 'string' && value ? value : null;
  return {
    version: tag, name: string(data.name), publishedAt: string(data.published_at),
    notes: string(data.body)?.slice(0, MAX_NOTES) ?? null, url: string(data.html_url),
  };
}

async function check(): Promise<Release> {
  status.state = 'checking'; status.error = null; status.startedAt = new Date().toISOString(); status.finishedAt = null;
  write();
  const release = await latestRelease();
  status.latest = release;
  status.checkedAt = new Date().toISOString();
  status.state = isNewer(release.version, version) ? 'available' : 'up_to_date';
  log('info', 'update_checked', { current: version, latest: release.version, state: status.state });
  return release;
}

function runInstaller(release: Release): Promise<number | null> {
  return new Promise(resolve => {
    // --download lädt das Release-Paket, prüft die Prüfsumme und führt dessen
    // install.sh aus, wie beim Aufruf per curl. Fehlschläge rollt es selbst zurück.
    const child = spawn('bash', [installer, '--download'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SCREENABLE_VERSION: release.version, SCREENABLE_REPO: repo, SCREENABLE_GITHUB_TOKEN: token() },
    });
    let lastWrite = 0;
    let rest = '';
    const collect = (chunk: Buffer) => {
      process.stdout.write(chunk);
      const lines = (rest + chunk.toString('utf8')).split('\n');
      rest = lines.pop() || '';
      status.log.push(...lines.map(line => line.trimEnd()).filter(Boolean));
      status.log = status.log.slice(-LOG_LINES);
      if (Date.now() - lastWrite > 1000) { lastWrite = Date.now(); write(); }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', error => { status.log.push(errorText(error)); resolve(null); });
    child.on('close', code => {
      if (rest.trim()) status.log = [...status.log, rest.trim()].slice(-LOG_LINES);
      resolve(code);
    });
  });
}

async function install(): Promise<void> {
  // Immer erneut prüfen: installiert wird nur das aktuell neueste Release.
  const release = await check();
  if (status.state !== 'available') { write(); return; }
  if (!existsSync(installer)) throw new Error(`Installer fehlt: ${installer}`);
  status.state = 'installing'; status.log = []; status.startedAt = new Date().toISOString();
  write();
  log('info', 'update_installing', { from: version, to: release.version });
  const code = await runInstaller(release);
  if (code !== 0) throw new Error(`Installation von ${release.version} fehlgeschlagen (Code ${code ?? 'unbekannt'}); das bisherige Release bleibt aktiv. Protokoll: /var/log/screenable-player-install.log`);
  status.state = 'installed';
  status.currentVersion = release.version.replace(/^v/, '');
  log('info', 'update_installed', { version: release.version });
}

// Weitere Anforderungen, die während eines Laufs eintreffen, werden danach bearbeitet.
for (;;) {
  const request = readUpdateRequest(updateRequestPath);
  if (!request || request.id === status.requestId) break;
  status.requestId = request.id;
  if (Date.now() - request.createdAt > REQUEST_MAX_AGE_MS) { log('warn', 'update_request_stale', { id: request.id }); write(); continue; }
  try {
    if (request.action === 'check') await check();
    else await install();
  } catch (error) {
    status.state = 'failed';
    status.error = errorText(error);
    log('error', 'update_failed', { action: request.action, error: status.error });
  }
  status.finishedAt = new Date().toISOString();
  write();
}
