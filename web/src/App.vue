<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';

type Config = { revision: number; mode: 'single'; outputId: string | null; contentUrl: string | null };
type Display = { id: string; primary: boolean; geometry: string | null };
type Status = { player: { state: string; browserPid: number | null; outputId: string | null; displays: Display[]; network: string; lastError: string | null; updatedAt: string } };

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

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`/api/v1${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.method && options.method !== 'GET' && csrf.value ? { 'x-csrf-token': csrf.value } : {}), ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function load() {
  const [c, s] = await Promise.all([request('/config'), request('/status')]);
  config.value = c;
  status.value = s;
  contentUrl.value = c.contentUrl || '';
  outputId.value = c.outputId || '';
}

async function refreshStatus() {
  if (!loggedIn.value) return;
  try { status.value = await request('/status'); } catch { /* Beim nächsten Poll erneut versuchen. */ }
}

async function login() {
  busy.value = true; error.value = ''; message.value = '';
  try {
    const session = await request('/login', { method: 'POST', body: JSON.stringify({ password: password.value }) });
    csrf.value = session.csrf;
    loggedIn.value = true;
    password.value = '';
    await load();
  } catch (e) { error.value = String((e as Error).message); }
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
  } catch (e) { error.value = String((e as Error).message); }
  finally { busy.value = false; }
}

async function action(name: 'reload' | 'restart') {
  busy.value = true; error.value = ''; message.value = '';
  try {
    await request(`/player/${name}`, { method: 'POST' });
    message.value = name === 'reload' ? 'Neu laden angefordert.' : 'Browser-Neustart angefordert.';
  } catch (e) { error.value = String((e as Error).message); }
  finally { busy.value = false; }
}

async function logout() {
  await request('/logout', { method: 'POST' });
  loggedIn.value = false; csrf.value = ''; config.value = null; status.value = null;
}

onMounted(async () => {
  try {
    const session = await request('/session');
    loggedIn.value = session.loggedIn;
    csrf.value = session.csrf || '';
    if (loggedIn.value) await load();
  } catch (e) { error.value = String((e as Error).message); }
  poll = setInterval(refreshStatus, 5000);
});
onUnmounted(() => { if (poll) clearInterval(poll); });
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
        <span class="state-pill" :class="status?.player.state === 'running' ? 'ok' : 'warn'">
          <span class="dot"></span>{{ status?.player.state === 'running' ? 'Player läuft' : 'Player wartet' }}
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
              <option v-for="display in status?.player.displays || []" :key="display.id" :value="display.id">{{ display.id }} {{ display.geometry ? `· ${display.geometry}` : '' }}</option>
            </select>
            <button class="primary" :disabled="busy">Änderungen speichern</button>
          </form>
        </section>

        <section class="card status-card">
          <div class="card-heading"><span class="icon">◉</span><div><h2>Status</h2><p>Live vom lokalen Player-Prozess.</p></div></div>
          <dl>
            <div><dt>Zustand</dt><dd>{{ status?.player.state || 'Unbekannt' }}</dd></div>
            <div><dt>Browser PID</dt><dd>{{ status?.player.browserPid || '–' }}</dd></div>
            <div><dt>Aktiver Ausgang</dt><dd>{{ status?.player.outputId || '–' }}</dd></div>
            <div><dt>Netzwerk (DNS)</dt><dd>{{ status?.player.network || '–' }}</dd></div>
            <div><dt>Aktualisiert</dt><dd>{{ status?.player.updatedAt ? new Date(status.player.updatedAt).toLocaleTimeString('de-DE') : '–' }}</dd></div>
          </dl>
          <p v-if="status?.player.lastError" class="notice error">{{ status.player.lastError }}</p>
          <div class="actions"><button class="secondary" :disabled="busy || !config?.contentUrl" @click="action('reload')">Seite neu laden</button><button class="secondary" :disabled="busy || !config?.contentUrl" @click="action('restart')">Browser neu starten</button></div>
        </section>
      </div>
      <p v-if="message" class="notice success">{{ message }}</p>
      <p v-if="error" class="notice error">{{ error }}</p>
      <footer>Screenable Player · Single-Screen-Prototyp</footer>
    </template>
  </main>
</template>
