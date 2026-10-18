import type { NativeModule } from './types';

interface Midi {
  playMidiFallback(url: string, volume: number, loop: number): Promise<number>;
  stopMidiFallback(handle: number): void;
  setMidiFallbackVolume(handle: number, volume: number): void;
}
interface Sound {
  source?: AudioBufferSourceNode;
  gain?: GainNode;
  media?: HTMLAudioElement;
  midi?: number;
  fallback?: () => void;
  stopped: boolean;
  volume: number;
}

export function installAudio(module: () => NativeModule | undefined) {
  let context: AudioContext | undefined;
  let nextHandle = 1;
  const sounds = new Map<number, Sound>();
  let midi: Midi | undefined;
  let midiPromise: Promise<Midi> | undefined;
  const midiPath = '/lib/midi-fallback.mjs';
  const loadMidi = () => (midiPromise ??= import(midiPath).then((module) => (midi = module as Midi)));
  const getContext = () => (context ??= new AudioContext());
  const volume = (value: number) => Math.min(1, Math.max(0, value));
  const unlock = () => {
    void getContext().resume();
    for (const sound of sounds.values()) {
      if (sound.fallback) sound.fallback();
      else if (sound.media && !sound.stopped) void sound.media.play().catch(() => {});
    }
  };
  window.addEventListener('pointerdown', unlock, { capture: true, once: true });
  window.addEventListener('keydown', unlock, { capture: true, once: true });
  function play(buffer: AudioBuffer, gainValue: number, loop: number, handle = nextHandle++) {
    const ctx = getContext();
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = buffer;
    source.loop = Boolean(loop);
    gain.gain.value = volume(gainValue);
    source.connect(gain).connect(ctx.destination);
    sounds.set(handle, { source, gain, stopped: false, volume: gainValue });
    source.onended = () => {
      sounds.delete(handle);
      source.disconnect();
      gain.disconnect();
    };
    source.start();
    return handle;
  }
  const callbacks = {
    __wasm_play_pcm(pointer: number, length: number, gain: number, rate: number, channels: number, loop: number) {
      const native = module();
      if (!native || !length || !channels || !rate || gain <= 0) return 0;
      const samples = new Int16Array(native.HEAPU8.buffer, pointer, length / 2);
      const frames = Math.floor(samples.length / channels);
      const buffer = getContext().createBuffer(channels, frames, rate);
      for (let channel = 0; channel < channels; channel++) {
        const data = buffer.getChannelData(channel);
        for (let frame = 0; frame < frames; frame++) data[frame] = (samples[frame * channels + channel] ?? 0) / 32768;
      }
      return play(buffer, gain, loop);
    },
    __wasm_play_music(pointer: number, length: number, gain: number, loop: number) {
      const native = module();
      if (!native) return 0;
      const handle = nextHandle++;
      const pending = { stopped: false, volume: gain };
      sounds.set(handle, pending);
      void getContext()
        .decodeAudioData(native.HEAPU8.slice(pointer, pointer + length).buffer)
        .then((buffer) => {
          if (!pending.stopped) play(buffer, pending.volume, loop, handle);
        })
        .catch(() => sounds.delete(handle));
      return handle;
    },
    __wasm_play_music_url(path: string, gain: number, loop: number) {
      const url = new URL(path, location.origin);
      if (url.origin !== location.origin || !url.pathname.startsWith('/gamefiles/')) return 0;
      const media = new Audio(url.href);
      media.volume = volume(gain);
      media.loop = Boolean(loop);
      const handle = nextHandle++;
      const sound: Sound = { media, stopped: false, volume: gain };
      sounds.set(handle, sound);
      media.onerror = () => {
        let starting = false;
        sound.fallback = () => {
          if (starting || sound.stopped || !navigator.userActivation.hasBeenActive) return;
          starting = true;
          void loadMidi()
            .then(async (library) => {
              const result = await library.playMidiFallback(url.href, sound.volume, loop);
              if (sound.stopped) library.stopMidiFallback(result);
              else sound.midi = result;
            })
            .catch(() => sounds.delete(handle));
        };
        sound.fallback();
      };
      media.onended = () => sounds.delete(handle);
      void media.play().catch((error: DOMException) => {
        if (error.name !== 'NotAllowedError') media.onerror?.(new Event('error'));
      });
      return handle;
    },
    __wasm_stop_sound(handle: number) {
      const sound = sounds.get(handle);
      if (!sound) return;
      sound.stopped = true;
      sound.source?.stop();
      sound.media?.pause();
      if (sound.midi) midi?.stopMidiFallback(sound.midi);
      sounds.delete(handle);
    },
    __wasm_set_sound_volume(handle: number, gain: number) {
      const sound = sounds.get(handle);
      if (!sound) return;
      sound.volume = volume(gain);
      if (sound.gain) sound.gain.gain.value = sound.volume;
      if (sound.media) sound.media.volume = sound.volume;
      if (sound.midi) midi?.setMidiFallbackVolume(sound.midi, sound.volume);
    }
  };
  Object.assign(globalThis, callbacks);
}
