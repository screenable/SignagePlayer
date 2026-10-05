<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

type Config = { revision: number; mode: 'single'; outputId: string | null; contentUrl: string | null };
type Display = { id: string; primary: boolean; geometry: string | null };
type Player = { state: string; browserPid: number | null; outputId: string | null; displays?: Display[]; network?: string; lastError: string | null; updatedAt?: string };
type Status = { version: string; tls: { validTo: string; daysLeft: number; expiresSoon: boolean } | null; player: Player };

const stateLabels: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' }> = {
  running: { label: 'Player läuft', tone: 'ok' },
  restarting: { label: 'Startet neu', tone: 'warn' },
  waiting_for_url: { label: 'Kein Inhalt', tone: 'warn' },
  waiting_for_display: { label: 'Kein Display', tone: 'bad' },
  error: { label: 'Fehler', tone: 'bad' },
  offline: { label: 'Player offline', tone: 'bad' },
  unknown: { label: 'Status unbekannt', tone: 'bad' },
};
const networkLabels: Record<string, string> = { online: 'Erreichbar', offline: 'Nicht erreichbar', unknown: 'Unbekannt' };

class HttpError extends Error { constructor(message: string, readonly status: number) { super(message); } }

const loggedIn = ref(false);
const password = ref('');
const csrf = ref('');
const config = ref<Config | null>(null);
const status = ref<Status | null>(null);
const contentUrl = ref('');
const outputId = ref('');
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

function signedOut(text = '') {
  loggedIn.value = false; csrf.value = ''; config.value = null; status.value = null;
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
  if (e instanceof HttpError && e.status === 401 && loggedIn.value) { signedOut('Sitzung abgelaufen. Bitte erneut anmelden.'); return; }
  error.value = (e as Error).message;
}

async function load() {
  const [c, s] = await Promise.all([request('/config'), request('/status')]);
  config.value = c;
  status.value = s;
  contentUrl.value = c.contentUrl || '';
  outputId.value = c.outputId || '';
}

async function refreshStatus() {
  if (!loggedIn.value || document.hidden) return;
  try { status.value = await request('/status'); }
  catch (e) { if (e instanceof HttpError && e.status === 401) show(e); /* Sonst beim nächsten Poll erneut versuchen. */ }
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
      body: JSON.stringify({ outputId: outputId.value || null, contentUrl: contentUrl.value.trim() || null }),
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
      <div class="brand"><span class="brand-mark">S</span><span>Screenable <strong>Player</strong></span></div>
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
            <input id="url" v-model="contentUrl" type="url" placeholder="https://example.com/inhalt" spellcheck="false" />
            <p class="hint">HTTPS, oder HTTP auf localhost für Hardwaretests. Leer lassen, um die Anzeige zu pausieren.</p>
            <label for="output">HDMI-Ausgang</label>
            <select id="output" v-model="outputId">
              <option value="">Automatisch (Primäranzeige)</option>
              <option v-for="display in outputs" :key="display.id" :value="display.id">{{ display.id }} {{ display.geometry ? `· ${display.geometry}` : '' }}</option>
            </select>
            <button class="primary" :disabled="busy">Änderungen speichern</button>
          </form>
        </section>

        <section class="card status-card">
          <div class="card-heading"><span class="icon">◉</span><div><h2>Status</h2><p>Live vom lokalen Player-Prozess.</p></div></div>
          <dl>
            <div><dt>Zustand</dt><dd>{{ playerState.label }}</dd></div>
            <div><dt>Browser PID</dt><dd>{{ status?.player.browserPid || '–' }}</dd></div>
            <div><dt>Aktiver Ausgang</dt><dd>{{ status?.player.outputId || '–' }}</dd></div>
            <div><dt>Inhalteserver</dt><dd>{{ networkLabels[status?.player.network || ''] || '–' }}</dd></div>
            <div><dt>Aktualisiert</dt><dd>{{ status?.player.updatedAt ? new Date(status.player.updatedAt).toLocaleTimeString('de-DE') : '–' }}</dd></div>
          </dl>
          <p v-if="status?.player.lastError" class="notice error">{{ status.player.lastError }}</p>
          <div class="actions"><button class="secondary" :disabled="busy || !config?.contentUrl" @click="action('reload')">Seite neu laden</button><button class="secondary" :disabled="busy || !config?.contentUrl" @click="action('restart')">Browser neu starten</button></div>
        </section>
      </div>
      <p v-if="status?.tls?.expiresSoon" class="notice error">Das TLS-Zertifikat des Dashboards läuft am {{ new Date(status.tls.validTo).toLocaleDateString('de-DE') }} ab. Bitte erneuern (siehe Betriebsanleitung).</p>
      <p v-if="message" class="notice success">{{ message }}</p>
      <p v-if="error" class="notice error">{{ error }}</p>
      <footer>Screenable Player{{ status?.version ? ` ${status.version}` : '' }} · Single-Screen</footer>
    </template>
  </main>
</template>
