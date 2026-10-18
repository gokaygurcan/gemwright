// midi-fallback.mjs — MIDI fallback for tracks missing as .mp3.

import { WorkletSynthesizer, Sequencer } from './spessasynth_lib.js';

// ── Module state ────────────────────────────────────────────────────────
let _initPromise = null;
let _ctx = null;
let _synth = null;
let _gain = null;
let _activeSeq = null;
let _activeHandle = 0;
let _nextHandle = 1;
let _shardUrlBase = null;
let _currentGeneration = 0;

async function findMidiUrl(mp3Url) {
  let u;
  try { u = new URL(mp3Url); } catch { return null; }
  const m = u.pathname.match(/^(.*?)\/music\//i);
  if (!m) return null;
  const shardPrefix = m[1] || '';
  _shardUrlBase = u.origin + shardPrefix;

  const baseMatch = u.pathname.match(/\/([^\/]+)\.mp3$/i);
  if (!baseMatch) return null;
  const raw = baseMatch[1].toLowerCase();
  // v0.8.84: route the .mid probes through the content-addressed pool rewriter
  // (window.__rewriteGamefileUrl) just like the .mul loader + the .mp3 path —
  // the raw /<base>/music/<name>.mid name doesn't exist on disk in the pool-only
  // layout, so the old raw probes always 404'd. The rewriter resolves each name
  // to /<base>/pool/<hash>.mid.br (or returns null = known-absent → skip fetch).
  const names = [`music/4mb/${raw}.mid`, `music/${raw}.mid`, `music/512k/${raw}.mid`];
  const rw = (typeof window !== 'undefined') ? window.__rewriteGamefileUrl : null;
  const probes = names.map((name) => {
    let url;
    if (typeof rw === 'function') {
      const r = rw(name);
      if (!r) return Promise.resolve(null);   // not in manifest → known-absent
      url = new URL(r, location.href).href;
    } else {
      url = u.origin + shardPrefix + '/' + name; // legacy: raw shard-base path
    }
    return fetch(url, { credentials: 'same-origin' })
      .then((r) => (r.ok ? url : null))
      .catch(() => null);
  });
  const results = await Promise.all(probes);
  for (const url of results) {
    if (url) return url;  // first OK in preference order
  }
  return null;
}

function ensureSynthReady() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const sf2Url = './lib/GeneralUser-GS.sf2';
    const r = await fetch(sf2Url, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`SF2 fetch failed: ${r.status} ${sf2Url}`);
    const sf2 = await r.arrayBuffer();
    _ctx = new (window.AudioContext || window.webkitAudioContext)();
    const workletKey = './lib/spessasynth_processor.min.js';
    let workletUrl = workletKey;
    try {
      const tag = document.querySelector('script[type="importmap"]');
      if (tag) {
        const map = JSON.parse(tag.textContent);
        if (map?.imports?.[workletKey]) workletUrl = map.imports[workletKey];
      }
    } catch { /* keep unsuffixed default */ }
    await _ctx.audioWorklet.addModule(new URL(workletUrl, document.baseURI).href);
    _synth = new WorkletSynthesizer(_ctx);
    await _synth.soundBankManager.addSoundBank(sf2, 'main');
    await _synth.isReady;
    // Volume gate so each playMidiFallback can adjust per-track gain.
    _gain = _ctx.createGain();
    _gain.gain.value = 1;
    _synth.connect(_gain);
    _gain.connect(_ctx.destination);
  })().catch((err) => {
    console.warn('[midi-fallback] init failed:', err);
    _initPromise = null;            // allow retry on next call
    throw err;
  });
  return _initPromise;
}

function stopActiveMidi() {
  if (_activeSeq) {
    try { _activeSeq.pause(); } catch { /* ignore */ }
    _activeSeq = null;
  }
  if (_synth) {
    try { _synth.stopAll(true); } catch { /* ignore */ }
  }
  _activeHandle = 0;
}

/**
 * Public: try to play a .mid fallback for the failed .mp3 URL. Returns
 * a non-zero handle on success, 0 if no .mid found / synth init failed.
 *
 * @param {string} mp3Url — the URL the wasm passed to __wasm_play_music_url.
 * @param {number} volume — 0..1
 * @param {number} loop   — 0 or 1
 */
export async function playMidiFallback(mp3Url, volume, loop) {
  // Take a generation slot up-front. Any await below that returns to a
  // stale generation has been superseded by a newer call and must bail
  // that overlaps the newer call's track.
  const gen = ++_currentGeneration;
  // Stop any currently-playing MIDI immediately, before any awaits.
  // Without this, between here and `seq.play()` below the previous
  // track keeps producing audio — and a fast zone change on a slow
  // SF2 init layer the new MIDI on top of the old.
  stopActiveMidi();
  try {
    const midiUrl = await findMidiUrl(mp3Url);
    if (gen !== _currentGeneration) return 0;
    if (!midiUrl) return 0;
    await ensureSynthReady();
    if (gen !== _currentGeneration) return 0;
    // Resume context if suspended (autoplay policy). The caller will
    // also have done this for the .mp3 path; double-call is harmless.
    if (_ctx.state === 'suspended') {
      await _ctx.resume().catch(() => {});
      if (gen !== _currentGeneration) return 0;
    }
    const r = await fetch(midiUrl, { credentials: 'same-origin' });
    if (gen !== _currentGeneration) return 0;
    if (!r.ok) return 0;
    const buf = await r.arrayBuffer();
    if (gen !== _currentGeneration) return 0;
    // One more guard — an even-newer caller could have arrived during
    // the arrayBuffer() decode; stopActiveMidi() it set won't catch
    stopActiveMidi();
    const seq = new Sequencer(_synth, { skipToFirstNoteOn: true });
    const fileName = midiUrl.split('/').pop() || 'fallback.mid';
    seq.loadNewSongList([{ binary: buf, fileName }]);
    seq.loopCount = loop ? -1 : 0;       // -1 = infinite, 0 = play once
    seq.play();
    _gain.gain.value = Math.max(0, Math.min(1, volume ?? 1));
    const handle = _nextHandle++;
    _activeSeq = seq;
    _activeHandle = handle;
    console.log(`[midi-fallback] playing ${midiUrl} (gen=${gen}, loop=${loop}, vol=${volume})`);
    return handle;
  } catch (err) {
    console.warn('[midi-fallback] play error:', err);
    return 0;
  }
}

/**
 * Public: stop a previously-started MIDI fallback. Matches by handle so
 * a stale stop call (e.g. for a track that was already replaced) is a
 * no-op rather than silencing the new one.
 */
export function stopMidiFallback(handle) {
  if (handle && handle === _activeHandle) stopActiveMidi();
}

/**
 * Public: adjust the active MIDI's volume. Same handle semantics as stop.
 */
export function setMidiFallbackVolume(handle, volume) {
  if (handle && handle === _activeHandle && _gain) {
    _gain.gain.value = Math.max(0, Math.min(1, volume ?? 1));
  }
}
