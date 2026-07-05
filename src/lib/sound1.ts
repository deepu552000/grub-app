"use client";

/**
 * Sound engine for Grub.
 *
 * - Sound effects (tap/feed/play/groom/nap/etc.) are still generated live
 *   with the Web Audio API — no files needed for those.
 * - Background music now plays real audio files (four lullaby tracks —
 *   two "Moonmilk Lullaby" and two "Lullaby" tracks), and the user can pick
 *   which one plays from a small track picker in the UI. A procedural
 *   "Chiptune" option is kept as a fallback in case the mp3 files aren't
 *   deployed yet.
 *
 * Usage inside a component:
 *
 *   const { playSfx, sfxOn, toggleSfx, musicOn, toggleMusic,
 *           volume, setVolume, musicTrack, setMusicTrack, musicTracks } = useGrubSound();
 *   playSfx("feed");
 *
 * Autoplay note: mobile browsers refuse to play audio until the user has
 * made a real tap/click somewhere on the page. useGrubSound() listens for
 * the very first pointerdown/keydown anywhere in the app and uses that to
 * unlock audio + start the background music (if the music preference is on).
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type SfxName =
  | "tap"
  | "feed"
  | "play"
  | "groom"
  | "nap"
  | "checkin"
  | "unlock"
  | "equip"
  | "evolve"
  | "error";

export type MusicTrack = {
  id: string;
  name: string;
  /** File path under /public. null = procedurally generated fallback (no file). */
  src: string | null;
};

// Drop the four mp3s at these paths under /public in your project.
export const MUSIC_TRACKS: MusicTrack[] = [
  { id: "moonmilk-1", name: "Moonmilk Lullaby I", src: "/sounds/moonmilk-lullaby-1.mp3" },
  { id: "moonmilk-2", name: "Moonmilk Lullaby II", src: "/sounds/moonmilk-lullaby-2.mp3" },
  { id: "lullaby-1", name: "Lullaby I", src: "/sounds/lullaby-1.mp3" },
  { id: "lullaby-2", name: "Lullaby II", src: "/sounds/lullaby-2.mp3" },
];

const VOLUME_KEY = "grub-sound-volume";
const SFX_KEY = "grub-sound-sfx-enabled";
const MUSIC_KEY = "grub-sound-music-enabled";
const TRACK_KEY = "grub-sound-music-track";

// A warm pentatonic-ish scale (Hz) shared by chimes and the procedural fallback loop.
const SCALE = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25];

function readBoolPref(key: string, fallback: boolean) {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  if (raw === null) return fallback;
  return raw === "1";
}

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;

  private volume = 0.85;
  private sfxEnabled = true;
  private musicEnabled = true; // preference — actual playback also needs the autoplay unlock
  private trackId: string = MUSIC_TRACKS[0].id;

  // procedural fallback loop
  private musicTimer: number | null = null;
  private musicDrones: OscillatorNode[] = [];
  private musicPlaying = false;

  // real file playback
  private audioEl: HTMLAudioElement | null = null;
  private audioSourceNode: MediaElementAudioSourceNode | null = null;

  constructor() {
    if (typeof window !== "undefined") {
      const storedVol = window.localStorage.getItem(VOLUME_KEY);
      this.volume = storedVol ? Math.min(1, Math.max(0, parseFloat(storedVol))) : 0.85;
      this.sfxEnabled = readBoolPref(SFX_KEY, true);
      this.musicEnabled = readBoolPref(MUSIC_KEY, true);
      const storedTrack = window.localStorage.getItem(TRACK_KEY);
      if (storedTrack && MUSIC_TRACKS.some((t) => t.id === storedTrack)) {
        this.trackId = storedTrack;
      }
    }
  }

  /** Must be called from inside (or shortly after) a real user gesture the first time. */
  private ensureContext() {
    if (this.ctx) return this.ctx;
    if (typeof window === "undefined") return null;
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return null;

    this.ctx = new Ctx();

    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;

    // A compressor lets us push individual tone gains much louder without
    // the risk of harsh digital clipping when several notes overlap.
    const compressor = this.ctx.createDynamicsCompressor();
    compressor.threshold.value = -24;
    compressor.knee.value = 30;
    compressor.ratio.value = 12;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;

    this.master.connect(compressor);
    compressor.connect(this.ctx.destination);

    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = 1;
    this.sfxBus.connect(this.master);

    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = 0.8; // real recordings are already mixed — don't attenuate hard
    this.musicBus.connect(this.master);

    return this.ctx;
  }

  resume() {
    const ctx = this.ensureContext();
    if (ctx && ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
  }

  getVolume() {
    return this.volume;
  }
  isSfxEnabled() {
    return this.sfxEnabled;
  }
  isMusicEnabled() {
    return this.musicEnabled;
  }
  isMusicPlaying() {
    return this.musicPlaying;
  }
  getTrackId() {
    return this.trackId;
  }

  setVolume(v: number) {
    this.volume = Math.min(1, Math.max(0, v));
    if (typeof window !== "undefined") window.localStorage.setItem(VOLUME_KEY, String(this.volume));
    if (this.master && this.ctx) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.linearRampToValueAtTime(this.volume, this.ctx.currentTime + 0.08);
    }
  }

  setSfxEnabled(next: boolean) {
    this.sfxEnabled = next;
    if (typeof window !== "undefined") window.localStorage.setItem(SFX_KEY, next ? "1" : "0");
  }

  /** Sets the music preference and immediately starts/stops playback to match. */
  setMusicEnabled(next: boolean) {
    this.musicEnabled = next;
    if (typeof window !== "undefined") window.localStorage.setItem(MUSIC_KEY, next ? "1" : "0");
    if (next) {
      this.startMusic();
    } else {
      this.stopMusic();
    }
  }

  /** Switches the active background track. Restarts playback immediately if music is currently on. */
  setTrack(id: string) {
    if (!MUSIC_TRACKS.some((t) => t.id === id)) return;
    this.trackId = id;
    if (typeof window !== "undefined") window.localStorage.setItem(TRACK_KEY, id);
    if (this.musicPlaying) {
      this.stopMusic();
      this.startMusic();
    }
  }

  // ---- low-level tone helper (a single oscillator with a soft attack/release) ----
  private tone(
    freq: number,
    {
      start = 0,
      duration = 0.18,
      type = "sine" as OscillatorType,
      gain = 0.22,
      detune = 0,
      bus,
    }: {
      start?: number;
      duration?: number;
      type?: OscillatorType;
      gain?: number;
      detune?: number;
      bus?: GainNode | null;
    } = {}
  ) {
    const ctx = this.ctx;
    if (!ctx) return;
    const target = bus ?? this.sfxBus;
    if (!target) return;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    osc.detune.value = detune;

    const env = ctx.createGain();
    env.gain.value = 0;

    osc.connect(env);
    env.connect(target);

    const t0 = ctx.currentTime + start;
    const attack = Math.min(0.02, duration * 0.3);
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(gain, t0 + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  // ---- SFX presets — tweak freely, these are just a starting point ----
  playSfx(name: SfxName) {
    if (!this.sfxEnabled) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    this.resume();

    switch (name) {
      case "tap": {
        this.tone(SCALE[Math.floor(Math.random() * 3) + 3], { duration: 0.09, gain: 0.35, type: "triangle" });
        break;
      }
      case "feed": {
        this.tone(SCALE[1], { duration: 0.14, gain: 0.4, type: "sine" });
        this.tone(SCALE[3], { start: 0.09, duration: 0.22, gain: 0.45, type: "sine" });
        break;
      }
      case "play": {
        [0, 2, 4].forEach((i, idx) =>
          this.tone(SCALE[i + 1], { start: idx * 0.07, duration: 0.14, gain: 0.38, type: "triangle" })
        );
        break;
      }
      case "groom": {
        [4, 5, 6, 7].forEach((i, idx) =>
          this.tone(SCALE[i], { start: idx * 0.05, duration: 0.16, gain: 0.28, type: "sine", detune: 6 })
        );
        break;
      }
      case "nap": {
        this.tone(SCALE[2], { duration: 0.5, gain: 0.3, type: "sine" });
        this.tone(SCALE[0], { start: 0.18, duration: 0.6, gain: 0.28, type: "sine" });
        break;
      }
      case "checkin": {
        this.tone(SCALE[3], { duration: 0.12, gain: 0.42, type: "square" });
        this.tone(SCALE[5], { start: 0.1, duration: 0.22, gain: 0.38, type: "sine" });
        break;
      }
      case "unlock": {
        [3, 5, 7].forEach((i, idx) =>
          this.tone(SCALE[i], { start: idx * 0.06, duration: 0.16, gain: 0.42, type: "square" })
        );
        break;
      }
      case "equip": {
        // Cute bouncy 4-note ascending run + a shimmering "sparkle" chord on top,
        // like a tiny magic-wand twinkle — much more "dress-up game" than a flat two-tone chime.
        const rootIndex = Math.floor(Math.random() * (SCALE.length - 3));
        const runNotes = [0, 1, 2, 3].map((offset) => SCALE[(rootIndex + offset) % SCALE.length]);
        runNotes.forEach((freq, idx) => {
          this.tone(freq, {
            start: idx * 0.05,
            duration: 0.13,
            gain: 0.4 - idx * 0.03,
            type: "triangle",
          });
        });
        const sparkleStart = runNotes.length * 0.05 + 0.02;
        const sparkleFreq = runNotes[runNotes.length - 1] * 2;
        this.tone(sparkleFreq, { start: sparkleStart, duration: 0.32, gain: 0.3, type: "sine", detune: 9 });
        this.tone(sparkleFreq, { start: sparkleStart + 0.015, duration: 0.3, gain: 0.2, type: "sine", detune: -7 });
        this.tone(sparkleFreq * 1.5, { start: sparkleStart + 0.03, duration: 0.24, gain: 0.14, type: "sine" });
        break;
      }
      case "evolve": {
        [0, 2, 4, 7].forEach((i, idx) =>
          this.tone(SCALE[i], { start: idx * 0.1, duration: 0.4, gain: 0.45, type: "sine" })
        );
        break;
      }
      case "error": {
        this.tone(220, { duration: 0.18, gain: 0.32, type: "sawtooth" });
        break;
      }
    }
  }

  // ---- background music ----
  startMusic() {
    const ctx = this.ensureContext();
    if (!ctx || !this.musicBus || this.musicPlaying) return;
    this.resume();

    const track = MUSIC_TRACKS.find((t) => t.id === this.trackId) ?? MUSIC_TRACKS[0];
    if (track.src) {
      this.startFileMusic(track.src);
    } else {
      this.startProceduralMusic();
    }
    this.musicPlaying = true;
  }

  private startFileMusic(src: string) {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus) return;

    if (!this.audioEl) {
      this.audioEl = new Audio();
      this.audioEl.loop = true;
      this.audioEl.crossOrigin = "anonymous";
    }
    if (!this.audioEl.src.endsWith(src)) {
      this.audioEl.src = src;
    }

    // createMediaElementSource can only be called once per <audio> element,
    // so we create the routing node lazily and reuse it across track switches.
    if (!this.audioSourceNode) {
      try {
        this.audioSourceNode = ctx.createMediaElementSource(this.audioEl);
        this.audioSourceNode.connect(this.musicBus);
      } catch {
        // already connected — safe to ignore
      }
    }

    this.audioEl.currentTime = 0;
    this.audioEl.play().catch(() => {});
  }

  private startProceduralMusic() {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus) return;

    const drone1 = ctx.createOscillator();
    const drone2 = ctx.createOscillator();
    const droneGain = ctx.createGain();
    drone1.type = "sine";
    drone2.type = "sine";
    drone1.frequency.value = SCALE[0] / 2;
    drone2.frequency.value = SCALE[0] / 2;
    drone2.detune.value = 6;
    droneGain.gain.value = 0.09;
    drone1.connect(droneGain);
    drone2.connect(droneGain);
    droneGain.connect(this.musicBus);
    drone1.start();
    drone2.start();
    this.musicDrones = [drone1, drone2];

    const playNote = () => {
      if (!this.musicPlaying) return;
      const note = SCALE[Math.floor(Math.random() * SCALE.length)];
      this.tone(note, { duration: 1.1, gain: 0.16, type: "sine", bus: this.musicBus });
      if (Math.random() < 0.35) {
        this.tone(note * 1.5, { start: 0.4, duration: 0.9, gain: 0.1, type: "sine", bus: this.musicBus });
      }
    };
    playNote();
    this.musicTimer = window.setInterval(playNote, 1400);
  }

  stopMusic() {
    this.musicPlaying = false;

    if (this.musicTimer) {
      window.clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
    this.musicDrones.forEach((osc) => {
      try {
        osc.stop();
      } catch {
        // already stopped — safe to ignore
      }
    });
    this.musicDrones = [];

    if (this.audioEl) {
      this.audioEl.pause();
    }
  }
}

let engineSingleton: SoundEngine | null = null;
function getEngine() {
  if (!engineSingleton) engineSingleton = new SoundEngine();
  return engineSingleton;
}

/** React hook wrapping the singleton SoundEngine with reactive sfx/music/volume/track state. */
export function useGrubSound() {
  const engineRef = useRef<SoundEngine>(getEngine());
  const [sfxOn, setSfxOnState] = useState(true);
  const [musicOn, setMusicOnState] = useState(true);
  const [volume, setVolumeState] = useState(0.85);
  const [musicTrack, setMusicTrackState] = useState(MUSIC_TRACKS[0].id);
  const unlockedRef = useRef(false);

  useEffect(() => {
    setSfxOnState(engineRef.current.isSfxEnabled());
    setMusicOnState(engineRef.current.isMusicEnabled());
    setVolumeState(engineRef.current.getVolume());
    setMusicTrackState(engineRef.current.getTrackId());
  }, []);

  // Mobile browsers block audio until a real tap/click has happened, so we
  // listen for the very first interaction anywhere in the app and use that
  // moment to unlock the AudioContext and — if the music preference is on —
  // kick off the background music.
  useEffect(() => {
    if (unlockedRef.current) return;
    const unlock = () => {
      if (unlockedRef.current) return;
      unlockedRef.current = true;
      engineRef.current.resume();
      if (engineRef.current.isMusicEnabled()) {
        engineRef.current.startMusic();
      }
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  const playSfx = useCallback((name: SfxName) => {
    engineRef.current.playSfx(name);
  }, []);

  const toggleSfx = useCallback(() => {
    const next = !engineRef.current.isSfxEnabled();
    engineRef.current.setSfxEnabled(next);
    setSfxOnState(next);
  }, []);

  const toggleMusic = useCallback(() => {
    const next = !engineRef.current.isMusicEnabled();
    engineRef.current.setMusicEnabled(next);
    setMusicOnState(next);
  }, []);

  const setVolume = useCallback((v: number) => {
    engineRef.current.setVolume(v);
    setVolumeState(v);
  }, []);

  const setMusicTrack = useCallback((id: string) => {
    engineRef.current.setTrack(id);
    setMusicTrackState(id);
  }, []);

  return {
    playSfx,
    sfxOn,
    toggleSfx,
    musicOn,
    toggleMusic,
    volume,
    setVolume,
    musicTrack,
    setMusicTrack,
    musicTracks: MUSIC_TRACKS,
  };
}
