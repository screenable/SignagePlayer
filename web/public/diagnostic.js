const byId = id => document.getElementById(id);
const result = (id, text, ok) => { const el = byId(id); el.textContent = text; el.className = ok ? 'ok' : 'bad'; };
document.addEventListener('keydown', e => result('keyboard', `${e.key} erkannt`, true));
function pollGamepad() {
  const pad = navigator.getGamepads?.().find(Boolean);
  const button = pad?.buttons.findIndex(b => b.pressed);
  if (button >= 0) result('gamepad', `${pad.id}: Taste ${button}`, true);
  requestAnimationFrame(pollGamepad);
}
pollGamepad();
const canvas = byId('canvas');
const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
if (gl) {
  gl.clearColor(0.05, 0.53, 0.35, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  result('webgl', `${gl.getParameter(gl.VERSION)} · ${gl.getParameter(gl.RENDERER)}`, true);
} else result('webgl', 'Kein WebGL-Kontext', false);
function wavBlob() {
  const rate = 22050, count = rate / 3, data = new ArrayBuffer(44 + count * 2), view = new DataView(data);
  const str = (at, s) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  str(0, 'RIFF'); view.setUint32(4, data.byteLength - 8, true); str(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) view.setInt16(44 + i * 2, Math.sin(i * 2 * Math.PI * 660 / rate) * 6000, true);
  return new Blob([data], { type: 'audio/wav' });
}
async function mediaTests() {
  try {
    const ctx = new AudioContext(); const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.frequency.value = 440; gain.gain.value = 0.15; osc.connect(gain).connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.3); await ctx.resume();
    result('webaudio', ctx.state, ctx.state === 'running');
  } catch (e) { result('webaudio', String(e), false); }
  try {
    const audio = new Audio(URL.createObjectURL(wavBlob()));
    await audio.play(); result('audio', 'play() erfolgreich; Ton prüfen', true);
  } catch (e) { result('audio', String(e), false); }
  try {
    const video = byId('test-video'); video.srcObject = canvas.captureStream(15);
    await video.play(); result('video', 'play() erfolgreich', true);
  } catch (e) { result('video', String(e), false); }
}
byId('retry').addEventListener('click', mediaTests);
mediaTests();
