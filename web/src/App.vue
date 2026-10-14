<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

type Orientation = 'normal' | 'inverted' | 'left' | 'right';
type Config = { revision: number; mode: 'single'; outputId: string | null; contentUrl: string | null; orientations?: Record<string, Orientation>; volume?: number };
type App = { name: string; url: string; description: string | null };
type AppList = { source: string; apps: App[]; fetchedAt: string | null; error: string | null };
type Display = { id: string; primary: boolean; geometry: string | null; rotation?: Orientation };
type Player = { state: string; browserPid: number | null; outputId: string | null; orientation?: Orientation | null; displays?: Display[]; network?: string; audioOutput?: string | null; lastError: string | null; updatedAt?: string };
type Lte = { present: boolean; state: string | null; operator: string | null; technology: string | null; quality: number | null; bars: number; error: string | null };
type Status = { version: string; tls: { validTo: string; daysLeft: number; expiresSoon: boolean } | null; player: Player; lte?: Lte };
type Release = { version: string; name: string | null; publishedAt: string | null; notes: string | null; url: string | null };
type Update = { state: string; busy: boolean; currentVersion: string; latest: Release | null; checkedAt: string | null; finishedAt: string | null; error: string | null; log: string[] };

const stateLabels: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' }> = {
  running: { label: 'Player läuft', tone: 'ok' },
  restarting: { label: 'Startet neu', tone: 'warn' },
  waiting_for_url: { label: 'Kein Inhalt', tone: 'warn' },
  waiting_for_display: { label: 'Kein Display', tone: 'bad' },
  waiting_for_network: { label: 'Wartet auf Internet', tone: 'warn' },
  error: { label: 'Fehler', tone: 'bad' },
  offline: { label: 'Player offline', tone: 'bad' },
  unknown: { label: 'Status unbekannt', tone: 'bad' },
};
const networkLabels: Record<string, string> = { online: 'Erreichbar', offline: 'Nicht erreichbar', unknown: 'Unbekannt' };
// xrandr --rotate: "left" dreht das Bild gegen den Uhrzeigersinn, passend für einen
// Bildschirm, der im Uhrzeigersinn hochkant gedreht montiert ist.
const orientationLabels: Record<Orientation, string> = {
  normal: 'Querformat',
  inverted: 'Querformat, 180° gedreht',
  left: 'Hochformat, Bild 90° nach links gedreht',
  right: 'Hochformat, Bild 90° nach rechts gedreht',
};
const modemStates: Record<string, string> = {
  connected: 'Verbunden', registered: 'Im Netz, ohne Datenverbindung', connecting: 'Verbindet …', disconnecting: 'Trennt …',
  searching: 'Sucht Netz', enabled: 'Bereit, kein Netz', enabling: 'Startet', disabled: 'Ausgeschaltet', disabling: 'Schaltet aus',
  locked: 'SIM gesperrt (PIN)', failed: 'Fehler', initializing: 'Startet', unknown: 'Unbekannt',
};
const updateLabels: Record<string, string> = {
  idle: 'Noch nicht geprüft', checking: 'Suche nach Updates …', up_to_date: 'Aktuell', available: 'Update verfügbar',
  installing: 'Update wird installiert …', installed: 'Update installiert', failed: 'Fehlgeschlagen',
};

class HttpError extends Error { constructor(message: string, readonly status: number) { super(message); } }

const loggedIn = ref(false);
const password = ref('');
const csrf = ref('');
const config = ref<Config | null>(null);
const status = ref<Status | null>(null);
const contentUrl = ref('');
const outputId = ref('');
const orientations = ref<Record<string, Orientation>>({});
const update = ref<Update | null>(null);
const volume = ref(100);
const appCatalog = ref<AppList | null>(null);
const suggestionsOpen = ref(false);
const activeSuggestion = ref(-1);
const busy = ref(false);
const message = ref('');
const error = ref('');
let poll: ReturnType<typeof setInterval> | undefined;

const playerState = computed(() => stateLabels[status.value?.player.state || 'unknown'] || { label: status.value?.player.state || 'Unbekannt', tone: 'warn' as const });
const outputs = computed(() => {
  const list = [...(status.value?.player.displays || [])];
  // Konfigurierten, aktuell getrennten Ausgang weiter anzeigen, statt die Auswahl still zu leeren.
  if (config.value?.outputId && !list.some(d => d.id === config.value!.outputId)) list.push({ id: config.value.outputId, primary: false, geometry: null });
  return list;
});

const lte = computed(() => status.value?.lte);
const lteLabel = computed(() => {
  const value = lte.value;
  if (!value) return '–';
  if (!value.present) return value.error || 'Kein Modem';
  return [modemStates[value.state || ''] || value.state, value.operator, value.technology].filter(Boolean).join(' · ');
});

// Suche über Name, Beschreibung und Adresse; alle Suchbegriffe müssen vorkommen.
const suggestions = computed(() => {
  const apps = appCatalog.value?.apps || [];
  const terms = contentUrl.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 1 && apps.some(app => app.url.toLowerCase() === terms[0])) return [];
  return apps.filter(app => {
    const haystack = `${app.name} ${app.description || ''} ${app.url}`.toLowerCase();
    return terms.every(term => haystack.includes(term));
  }).slice(0, 8);
});
const selectedApp = computed(() => appCatalog.value?.apps.find(app => app.url === contentUrl.value.trim()) || null);

function chooseApp(app: App) {
  contentUrl.value = app.url;
  suggestionsOpen.value = false;
  activeSuggestion.value = -1;
}

function suggestionKey(event: KeyboardEvent) {
  const count = suggestions.value.length;
  if (!suggestionsOpen.value || !count) return;
  if (event.key === 'ArrowDown') { event.preventDefault(); activeSuggestion.value = (activeSuggestion.value + 1) % count; }
  else if (event.key === 'ArrowUp') { event.preventDefault(); activeSuggestion.value = (activeSuggestion.value - 1 + count) % count; }
  else if (event.key === 'Enter' && activeSuggestion.value >= 0) { event.preventDefault(); chooseApp(suggestions.value[activeSuggestion.value]); }
  else if (event.key === 'Escape') suggestionsOpen.value = false;
}

// Verzögert schließen, damit ein Klick auf einen Vorschlag noch ankommt.
function closeSuggestions() { setTimeout(() => { suggestionsOpen.value = false; }, 150); }

async function loadApps(refresh = false) {
  try { appCatalog.value = await request(`/apps${refresh ? '?refresh=1' : ''}`); }
  catch (e) { if (e instanceof HttpError && e.status === 401) show(e); }
}

async function saveVolume() {
  busy.value = true; error.value = ''; message.value = '';
  try {
    config.value = await request('/volume', { method: 'PUT', body: JSON.stringify({ volume: volume.value }) });
    message.value = volume.value === 0 ? 'Ton stumm geschaltet.' : `Lautstärke auf ${volume.value} % gesetzt.`;
  } catch (e) { show(e); }
  finally { busy.value = false; }
}

function signedOut(text = '') {
  loggedIn.value = false; csrf.value = ''; config.value = null; status.value = null; update.value = null;
  error.value = text;
}

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`/api/v1${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.method && options.method !== 'GET' && csrf.value ? { 'x-csrf-token': csrf.value } : {}), ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(data.error || `HTTP ${response.status}`, response.status);
  return data;
}

function show(e: unknown) {
  if (e instanceof HttpError && e.status === 401 && loggedIn.value) {
    // Ein Update startet das Dashboard neu; dabei enden alle Sitzungen.
    signedOut(update.value?.state === 'installing' ? 'Das Dashboard wurde für das Update neu gestartet. Bitte erneut anmelden.' : 'Sitzung abgelaufen. Bitte erneut anmelden.');
    return;
  }
  error.value = (e as Error).message;
}

async function load() {
  const [c, s, u] = await Promise.all([request('/config'), request('/status'), request('/update')]);
  config.value = c;
  status.value = s;
  update.value = u;
  contentUrl.value = c.contentUrl || '';
  outputId.value = c.outputId || '';
  orientations.value = { ...c.orientations };
  volume.value = c.volume ?? 100;
  void loadApps();
}

async function refreshStatus() {
  if (!loggedIn.value || document.hidden) return;
  try { [status.value, update.value] = await Promise.all([request('/status'), request('/update')]); }
  catch (e) { if (e instanceof HttpError && e.status === 401) show(e); /* Sonst beim nächsten Poll erneut versuchen. */ }
}

function orientationOf(id: string): Orientation { return orientations.value[id] || 'normal'; }
function setOrientation(id: string, value: string) {
  const next = { ...orientations.value };
  if (value === 'normal') delete next[id]; else next[id] = value as Orientation;
  orientations.value = next;
}

async function updateAction(name: 'check' | 'install') {
  if (name === 'install' && !confirm(`Version ${update.value?.latest?.version} jetzt installieren? Player und Dashboard starten dabei neu; die Anzeige ist kurz unterbrochen.`)) return;
  busy.value = true; error.value = ''; message.value = '';
  try {
    update.value = await request(`/update/${name}`, { method: 'POST' });
    if (name === 'install') message.value = 'Update gestartet. Das Dashboard ist während der Installation kurz nicht erreichbar.';
  } catch (e) { show(e); }
  finally { busy.value = false; }
}

async function login() {
  busy.value = true; error.value = ''; message.value = '';
  try {
    const session = await request('/login', { method: 'POST', body: JSON.stringify({ password: password.value }) });
    csrf.value = session.csrf;
    loggedIn.value = true;
    password.value = '';
    await load();
  } catch (e) { show(e); }
  finally { busy.value = false; }
}

async function save() {
  if (!config.value) return;
  busy.value = true; error.value = ''; message.value = '';
  try {
    const next = await request('/config', {
      method: 'PUT',
      headers: { 'if-match': String(config.value.revision) },
      body: JSON.stringify({ outputId: outputId.value || null, contentUrl: contentUrl.value.trim() || null, orientations: orientations.value }),
    });
    config.value = next;
    message.value = 'Gespeichert. Der Player übernimmt die Änderung in wenigen Sekunden.';
    await refreshStatus();
  } catch (e) { show(e); }
  finally { busy.value = false; }
}

async function action(name: 'reload' | 'restart') {
  busy.value = true; error.value = ''; message.value = '';
  try {
    await request(`/player/${name}`, { method: 'POST' });
    message.value = name === 'reload' ? 'Neu laden angefordert.' : 'Browser-Neustart angefordert.';
  } catch (e) { show(e); }
  finally { busy.value = false; }
}

async function logout() {
  try { await request('/logout', { method: 'POST' }); } catch { /* Sitzung ist ohnehin ungültig. */ }
  signedOut();
}

onMounted(async () => {
  try {
    const session = await request('/session');
    loggedIn.value = session.loggedIn;
    csrf.value = session.csrf || '';
    if (loggedIn.value) await load();
  } catch (e) { show(e); }
  poll = setInterval(refreshStatus, 5000);
  document.addEventListener('visibilitychange', refreshStatus);
});
onUnmounted(() => {
  if (poll) clearInterval(poll);
  document.removeEventListener('visibilitychange', refreshStatus);
});
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <div class="brand"><img class="brand-logo" src="/screenable-logo.png" alt="screenable" width="220" height="27" /><span class="brand-product">Player</span></div>
      <button v-if="loggedIn" class="text-button" @click="logout">Abmelden</button>
    </header>

    <section v-if="!loggedIn" class="login card">
      <div class="eyebrow">GERÄTESTEUERUNG</div>
      <h1>Willkommen zurück.</h1>
      <p>Melde dich an, um den Inhalt auf diesem Gerät zu verwalten.</p>
      <form @submit.prevent="login">
        <label for="password">Administratorpasswort</label>
        <input id="password" v-model="password" type="password" autocomplete="current-password" required />
        <button class="primary" :disabled="busy">Anmelden</button>
      </form>
      <p v-if="error" class="notice error">{{ error }}</p>
    </section>

    <template v-else>
      <div class="page-heading">
        <div><div class="eyebrow">GERÄTESTEUERUNG</div><h1>Übersicht</h1><p>Ein Bildschirm. Ein Inhalt. Klarer Status.</p></div>
        <span class="state-pill" :class="playerState.tone">
          <span class="dot"></span>{{ playerState.label }}
        </span>
      </div>

      <div class="grid">
        <section class="card content-card">
          <div class="card-heading"><span class="icon">↗</span><div><h2>Inhalt</h2><p>Die URL wird direkt im Chromium-Kiosk angezeigt.</p></div></div>
          <form @submit.prevent="save">
            <label for="url">Screenable-URL</label>
            <div class="combo">
              <input
                id="url" v-model="contentUrl" type="text" inputmode="url" autocomplete="off" spellcheck="false"
                placeholder="Anwendung suchen oder https://… eingeben"
                role="combobox" aria-autocomplete="list" aria-controls="app-suggestions" :aria-expanded="suggestionsOpen && suggestions.length > 0"
                @focus="suggestionsOpen = true" @input="suggestionsOpen = true; activeSuggestion = -1" @blur="closeSuggestions" @keydown="suggestionKey"
              />
              <ul v-if="suggestionsOpen && suggestions.length" id="app-suggestions" class="suggestions" role="listbox">
                <li v-for="(app, index) in suggestions" :key="app.url" role="option" :aria-selected="index === activeSuggestion" :class="{ active: index === activeSuggestion }" @mousedown.prevent="chooseApp(app)">
                  <strong>{{ app.name }}</strong>
                  <span v-if="app.description">{{ app.description }}</span>
                  <small>{{ app.url }}</small>
                </li>
              </ul>
            </div>
            <p v-if="selectedApp" class="hint selected-app">✓ {{ selectedApp.name }}</p>
            <p class="hint">
              Namen einer Screenable-Anwendung eintippen und aus der Liste wählen, oder eine eigene HTTPS-Adresse (HTTP nur für localhost) eingeben. Leer lassen, um die Anzeige zu pausieren.
              <template v-if="appCatalog?.apps.length"> {{ appCatalog.apps.length }} Anwendungen verfügbar.</template>
              <template v-else-if="appCatalog?.error"> {{ appCatalog.error }}</template>
              <button type="button" class="link-button" @click="loadApps(true)">Liste aktualisieren</button>
            </p>
            <label for="output">HDMI-Ausgang</label>
            <select id="output" v-model="outputId">
              <option value="">Automatisch (Primäranzeige)</option>
              <option v-for="display in outputs" :key="display.id" :value="display.id">{{ display.id }} {{ display.geometry ? `· ${display.geometry}` : '' }}</option>
            </select>
            <label>Ausrichtung je HDMI-Ausgang</label>
            <div v-if="outputs.length" class="orientation-list">
              <div v-for="display in outputs" :key="display.id" class="orientation-row">
                <span class="orientation-name">{{ display.id }}<small v-if="display.geometry">{{ display.geometry.split('+')[0] }}</small></span>
                <select :aria-label="`Ausrichtung ${display.id}`" :value="orientationOf(display.id)" @change="setOrientation(display.id, ($event.target as HTMLSelectElement).value)">
                  <option v-for="(label, value) in orientationLabels" :key="value" :value="value">{{ label }}</option>
                </select>
              </div>
            </div>
            <p v-else class="hint">Kein Bildschirm erkannt.</p>
            <p class="hint">„Nach links“ dreht das Bild gegen den Uhrzeigersinn – richtig für einen Bildschirm, der im Uhrzeigersinn hochkant montiert ist; „nach rechts“ für die Gegenrichtung.</p>
            <button class="primary" :disabled="busy">Änderungen speichern</button>
          </form>
        </section>

        <section class="card status-card">
          <div class="card-heading"><span class="icon">◉</span><div><h2>Status</h2><p>Live vom lokalen Player-Prozess.</p></div></div>
          <dl>
            <div><dt>Zustand</dt><dd>{{ playerState.label }}</dd></div>
            <div><dt>Browser PID</dt><dd>{{ status?.player.browserPid || '–' }}</dd></div>
            <div><dt>Aktiver Ausgang</dt><dd>{{ status?.player.outputId || '–' }}</dd></div>
            <div><dt>Ausrichtung</dt><dd>{{ status?.player.orientation ? orientationLabels[status.player.orientation] : '–' }}</dd></div>
            <div>
              <dt>LTE</dt>
              <dd class="lte">
                <span class="signal" :class="`bars-${lte?.bars || 0}`" role="img" :aria-label="`Signal ${lte?.bars || 0} von 5`" :title="lte?.quality != null ? `Signalqualität ${lte.quality} %` : ''">
                  <i v-for="n in 5" :key="n" :class="{ on: n <= (lte?.bars || 0) }"></i>
                </span>
                <span>{{ lteLabel }}</span>
              </dd>
            </div>
            <div><dt>Inhalteserver</dt><dd>{{ networkLabels[status?.player.network || ''] || '–' }}</dd></div>
            <div><dt>Tonausgabe</dt><dd>{{ status?.player.audioOutput || 'Kein HDMI-Ton' }}</dd></div>
            <div class="volume-row">
              <dt><label for="volume">Lautstärke</label></dt>
              <dd class="volume">
                <input id="volume" v-model.number="volume" type="range" min="0" max="100" step="5" :disabled="busy" @change="saveVolume" />
                <span>{{ volume === 0 ? 'Stumm' : `${volume} %` }}</span>
              </dd>
            </div>
            <div><dt>Aktualisiert</dt><dd>{{ status?.player.updatedAt ? new Date(status.player.updatedAt).toLocaleTimeString('de-DE') : '–' }}</dd></div>
          </dl>
          <p v-if="status?.player.lastError" class="notice error">{{ status.player.lastError }}</p>
          <div class="actions"><button class="secondary" :disabled="busy || !config?.contentUrl" @click="action('reload')">Seite neu laden</button><button class="secondary" :disabled="busy || !config?.contentUrl" @click="action('restart')">Browser neu starten</button></div>
        </section>
      </div>
      <section class="card update-card">
        <div class="card-heading"><span class="icon">⤓</span><div><h2>Software-Update</h2><p>Neue Releases von GitHub prüfen und einspielen. Bei einem Fehler bleibt die bisherige Version aktiv.</p></div></div>
        <dl>
          <div><dt>Installiert</dt><dd>{{ update?.currentVersion || status?.version || '–' }}</dd></div>
          <div><dt>Neuestes Release</dt><dd>{{ update?.latest ? update.latest.version : '–' }}{{ update?.latest?.publishedAt ? ` · ${new Date(update.latest.publishedAt).toLocaleDateString('de-DE')}` : '' }}</dd></div>
          <div><dt>Zustand</dt><dd :class="`update-${update?.state || 'idle'}`">{{ updateLabels[update?.state || 'idle'] || update?.state }}</dd></div>
          <div><dt>Zuletzt geprüft</dt><dd>{{ update?.checkedAt ? new Date(update.checkedAt).toLocaleString('de-DE') : '–' }}</dd></div>
        </dl>
        <p v-if="update?.error" class="notice error">{{ update.error }}</p>
        <details v-if="update?.state === 'available' && update.latest?.notes" class="release-notes">
          <summary>Änderungen in {{ update.latest.version }}</summary>
          <pre>{{ update.latest.notes }}</pre>
        </details>
        <pre v-if="update?.log?.length && (update.state === 'installing' || update.state === 'failed' || update.state === 'installed')" class="update-log">{{ update.log.join('\n') }}</pre>
        <div class="actions">
          <button class="secondary" :disabled="busy || update?.busy" @click="updateAction('check')">Nach Updates suchen</button>
          <button class="primary inline" :disabled="busy || update?.busy || update?.state !== 'available'" @click="updateAction('install')">Update installieren</button>
        </div>
      </section>
      <p v-if="status?.tls?.expiresSoon" class="notice error">Das TLS-Zertifikat des Dashboards läuft am {{ new Date(status.tls.validTo).toLocaleDateString('de-DE') }} ab. Bitte erneuern (siehe Betriebsanleitung).</p>
      <p v-if="message" class="notice success">{{ message }}</p>
      <p v-if="error" class="notice error">{{ error }}</p>
      <footer>Screenable Player{{ status?.version ? ` ${status.version}` : '' }} · Single-Screen</footer>
    </template>
  </main>
</template>
