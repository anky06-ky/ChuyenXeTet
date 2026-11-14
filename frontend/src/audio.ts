export type AudioChannel = 'music' | 'effects' | 'voice';
export type AudioCue = 'join' | 'work' | 'coffee' | 'salary' | 'bonus' | 'month' | 'boss' | 'click' | 'horn' | 'depart';
export type VoiceKey = 'welcome' | 'boss' | 'month' | 'bonus' | 'station' | 'depart';
export type VoiceMode = 'loading' | 'recorded' | 'speech-synthesis' | 'mixed' | 'unavailable';

export interface AudioStatus {
  enabled: boolean;
  muted: boolean;
  running: boolean;
  loading: boolean;
  volumes: Record<AudioChannel, number>;
  voiceAvailable: boolean;
  voiceMode: VoiceMode;
  recordedVoices: VoiceKey[];
  missingVoices: VoiceKey[];
  speechRequiresNetwork: boolean;
  speaking: VoiceKey | null;
  queuedVoices: number;
  missingAssets: string[];
  error: string | null;
  label: string;
}

const VOICE_TEXT: Record<VoiceKey, string> = {
  welcome: 'Chào mừng đến công ty cuối năm! Vào làm thôi nào.',
  boss: 'Sếp tới rồi! Cả nhà quay về bàn làm việc nha!',
  month: 'Sang tháng mới rồi! Cùng nhau chạy KPI nào!',
  bonus: 'Chốt sổ cuối năm! Cả nhà nhận thưởng Tết nào!',
  station: 'Bến xe Tết đã mở cửa! Bà con bình luận tên tỉnh thành hoặc số ghế từ 1 đến 24 để lên xe về quê ăn Tết nha!',
  depart: 'Chuyến xe Tết đã xuất bến! Chúc bà con thượng lộ bình an, về quê ăn Tết sum vầy!',
};
const VOICE_KEYS = Object.keys(VOICE_TEXT) as VoiceKey[];
const CUES: AudioCue[] = ['join', 'work', 'coffee', 'salary', 'bonus', 'month', 'boss', 'click', 'horn', 'depart'];
const COOLDOWN: Record<AudioCue, number> = {
  join: 0.2, work: 0.14, coffee: 0.4, salary: 0.18,
  bonus: 1.2, month: 1.2, boss: 2, click: 0.06,
  horn: 0.22, depart: 1.4,
};
const STORAGE_KEY = 'tetlive.audio.volumes.v1';
const DEFAULT_VOLUMES = { music: 0.65, effects: 0.75, voice: 0.92 };
const WATCHDOG_INTERVAL_MS = 1500;
const RESUME_RACE_MS = 300;
const clamp = (value: number): number => Math.max(0, Math.min(1, value));
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const nowSec = (): number => (typeof performance !== 'undefined' ? performance.now() / 1000 : Date.now() / 1000);

interface ActiveVoice {
  key: VoiceKey;
  cleanup: (cancel: boolean) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** Local audio with Web Audio primary graph and decoupled HTMLAudioElement fallback for CEF. */
export class AudioManager {
  enabled = false;
  muted = false;
  volumes: Record<AudioChannel, number> = { ...DEFAULT_VOLUMES };
  voiceAvailable = false;
  onStatus?: (status: AudioStatus) => void;

  private context: AudioContext | null = null;
  private webAudioUnavailable = false;
  private gains: Partial<Record<AudioChannel, GainNode>> = {};
  private compressor: DynamicsCompressorNode | null = null;
  private music: AudioBuffer | null = null;
  private officeMusic: AudioBuffer | null = null;
  private stationMusic: AudioBuffer | null = null;
  private scene: 'office' | 'station' = 'office';
  private musicSource: AudioBufferSourceNode | null = null;
  private musicOffset = 0;
  private musicStartedAt = 0;
  private effects = new Map<AudioCue, AudioBuffer>();
  private voices = new Map<VoiceKey, AudioBuffer>();
  private unavailableVoices = new Set<VoiceKey>();
  private effectSources = new Set<AudioBufferSourceNode>();
  private lastEffect = new Map<AudioCue, number>();
  private lastVoice = new Map<VoiceKey, number>();
  private pendingCues: AudioCue[] = [];
  private voiceQueue: VoiceKey[] = [];
  private activeVoice: ActiveVoice | null = null;
  private synthesis: SpeechSynthesis | null = null;
  private vietnameseVoice: SpeechSynthesisVoice | null = null;
  private synthesisFailed = false;
  private running = true;
  private disposed = false;
  private loading = false;
  private loaded = false;
  private wantsAudio = false;
  private finishing: Promise<void> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private fallbackMusicEl: HTMLAudioElement | null = null;
  private fallbackMusicScene: 'office' | 'station' | null = null;
  private _fallbackMusicPlaying = false;
  private fallbackEffectEls = new Set<HTMLAudioElement>();
  private fallbackVoiceEl: HTMLAudioElement | null = null;
  private requests = new Set<AbortController>();
  private missingAssets = new Set<string>();
  private error: string | null = null;
  private readonly voicesChanged = (): void => {
    this.refreshVoices();
    this.notify();
  };

  constructor(onStatus?: (status: AudioStatus) => void) {
    this.onStatus = onStatus;
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
      if (stored && typeof stored === 'object') {
        for (const channel of ['music', 'effects', 'voice'] as const) {
          const value = (stored as Record<string, unknown>)[channel];
          if (typeof value === 'number' && Number.isFinite(value)) this.volumes[channel] = clamp(value);
        }
      }
    } catch { /* Storage may be disabled or contain invalid JSON. */ }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      this.synthesis = window.speechSynthesis;
      this.synthesis.addEventListener('voiceschanged', this.voicesChanged);
      this.refreshVoices();
    }
    this.notify();
  }

  get contextState(): AudioContextState | 'uninitialized' {
    return this.context?.state ?? 'uninitialized';
  }

  get fallbackPlaying(): boolean {
    return this._fallbackMusicPlaying && !this.muted;
  }

  get status(): AudioStatus {
    const recordedVoices = VOICE_KEYS.filter((key) => this.voices.has(key));
    const fallback = this.vietnameseVoice !== null && !this.synthesisFailed;
    const missingVoices = VOICE_KEYS.filter((key) => !this.voices.has(key) && !fallback);
    const voiceMode: VoiceMode = this.loading ? 'loading'
      : recordedVoices.length === VOICE_KEYS.length ? 'recorded'
      : recordedVoices.length ? (fallback ? 'mixed' : 'recorded')
      : fallback ? 'speech-synthesis' : 'unavailable';
    const webAudioRunning = this.context?.state === 'running';
    let label = this.disposed ? 'Đã đóng âm thanh'
      : this.muted ? 'Đã tắt tiếng'
      : this.loading ? 'Đang tải âm thanh…'
      : this.enabled && webAudioRunning ? 'Âm thanh sẵn sàng'
      : this.fallbackPlaying ? 'Âm thanh sẵn sàng (chế độ dự phòng)'
      : this.loaded && this.context && !webAudioRunning ? 'Âm thanh tạm dừng · Bấm bật lại'
      : 'Bấm bật âm thanh';
    if (this.enabled && webAudioRunning && !this.loading && !this.muted) {
      label += voiceMode === 'recorded' ? ` · ${recordedVoices.length}/${VOICE_KEYS.length} câu thoại thu sẵn`
        : voiceMode === 'mixed' ? ' · Có dùng giọng đọc của trình duyệt'
        : voiceMode === 'speech-synthesis' ? ' · Giọng đọc tiếng Việt của trình duyệt'
        : ' · Chưa có giọng tiếng Việt';
      if (this.missingAssets.size) label += ' · Một số tệp âm thanh chưa tải được';
    }
    return {
      enabled: this.enabled, muted: this.muted, running: this.running, loading: this.loading,
      volumes: { ...this.volumes }, voiceAvailable: this.voiceAvailable, voiceMode,
      recordedVoices, missingVoices,
      speechRequiresNetwork: fallback && !this.vietnameseVoice!.localService,
      speaking: this.activeVoice?.key ?? null, queuedVoices: this.voiceQueue.length,
      missingAssets: [...this.missingAssets], error: this.error, label,
    };
  }

  /** Enable Web Audio (with autoplay/resume race and watchdog) plus decoupled <audio> fallback. */
  async enable(options: { autoplay?: boolean } = {}): Promise<void> {
    if (this.disposed) return;
    const activation = typeof navigator !== 'undefined' ? navigator.userActivation : undefined;
    if (!options.autoplay && !this.enabled && activation && !activation.isActive) {
      this.error = 'Hãy bấm nút bật âm thanh để trình duyệt cho phép phát.';
      this.notify();
      return;
    }
    this.wantsAudio = true;
    try {
      if (!this.context && !this.webAudioUnavailable) {
        try {
          this.createContext();
        } catch {
          this.webAudioUnavailable = true;
        }
      }

      if (this.context) {
        // Call resume() synchronously inside the caller's gesture/startup before any await.
        const resumePromise = this.context.state !== 'running'
          ? this.context.resume().catch(() => {})
          : Promise.resolve();
        if (this.context.state !== 'running') {
          await Promise.race([resumePromise, delay(RESUME_RACE_MS)]);
          if (this.disposed) return;
        }
        if (this.context.state === 'running') {
          await this.finishEnable();
          return;
        }
        // Still suspended: keep context alive, wire watchdog, and try decoupled <audio> fallback.
        this.ensureWatchdog();
      }

      const fallbackOk = await this.tryStartFallbackMusic();
      if (this.disposed) return;
      if (!options.autoplay && !fallbackOk && this.context?.state !== 'running') {
        this.error = 'Trình duyệt chưa cho phát âm thanh. Hãy bấm bật lại.';
      } else {
        this.error = null;
      }
      this.notify();
    } catch {
      if (this.disposed) return;
      this.loading = false;
      if (!options.autoplay) {
        this.error = 'Trình duyệt chưa cho phát âm thanh. Hãy bấm bật lại.';
      }
      this.notify();
    }
  }

  setVolume(channel: AudioChannel, value: number): void {
    if (this.disposed || !Number.isFinite(value) || !Object.hasOwn(this.volumes, channel)) return;
    this.volumes[channel] = clamp(value);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.volumes)); } catch { /* Optional persistence. */ }
    if (channel === 'voice' && value <= 0) this.clearVoices();
    this.updateGains();
    this.syncMusic();
    this.notify();
  }

  setMuted(muted: boolean): void {
    if (this.disposed) return;
    this.muted = muted;
    if (muted) {
      this.clearVoices();
      this.stopEffects();
      this.stopFallbackMusic();
    }
    this.updateGains();
    this.syncMusic();
    this.notify();
  }

  /** Pause/resume the music bed. Cue previews remain available while the game is paused. */
  setRunning(running: boolean): void {
    if (this.disposed) return;
    this.running = running;
    this.syncMusic();
    this.notify();
  }

  /** Switch background music loop between office and bus station scenes. */
  setScene(scene: 'office' | 'station'): void {
    if (this.disposed || this.scene === scene) return;
    this.scene = scene;
    const nextBuffer = scene === 'station' ? (this.stationMusic ?? this.officeMusic) : (this.officeMusic ?? this.stationMusic);
    if (this.music !== nextBuffer) {
      this.stopMusic();
      this.musicOffset = 0;
      this.music = nextBuffer;
      if (this.context && this.gains.music && this.canPlay()) {
        const gain = this.gains.music.gain;
        gain.cancelScheduledValues(this.context.currentTime);
        gain.setValueAtTime(0, this.context.currentTime);
      }
    }
    this.syncMusic();
    this.updateGains();
    this.notify();
  }

  play(cue: AudioCue): void {
    if (this.disposed || !this.wantsAudio || this.muted || !this.volumes.effects) return;
    const now = nowSec();
    const previous = this.lastEffect.get(cue);
    if (previous !== undefined && now - previous < COOLDOWN[cue]) return;

    if (this.canPlay()) {
      const buffer = this.effects.get(cue);
      if (buffer) {
        if (this.effectSources.size >= 6) return;
        let source: AudioBufferSourceNode | null = null;
        try {
          source = this.context!.createBufferSource();
          source.buffer = buffer;
          source.connect(this.gains.effects!);
          const node = source;
          node.onended = () => {
            this.effectSources.delete(node);
            node.disconnect();
          };
          this.effectSources.add(node);
          source.start();
          this.lastEffect.set(cue, now);
          return;
        } catch {
          if (source) { this.effectSources.delete(source); source.disconnect(); }
        }
      }
    }
    if (this.context?.state === 'running' && this.loading) {
      if (!this.pendingCues.includes(cue)) {
        if (this.pendingCues.length >= 4) this.pendingCues.shift();
        this.pendingCues.push(cue);
      }
      return;
    }

    // Decoupled <audio> fallback when Web Audio is suspended/unavailable or buffer decoding failed.
    this.playFallbackEffect(cue, now);
  }

  say(key: VoiceKey): void {
    if (this.disposed || !this.wantsAudio || this.muted || !this.volumes.voice || !VOICE_KEYS.includes(key)) return;
    if (this.activeVoice?.key === key || this.voiceQueue.includes(key)) return;
    const now = nowSec();
    const previous = this.lastVoice.get(key);
    if (previous !== undefined && now - previous < 4) return;
    const canTryRecorded = !this.unavailableVoices.has(key);
    const canTrySpeech = this.vietnameseVoice !== null && !this.synthesisFailed;
    if (!this.loading && !this.voices.has(key) && !canTryRecorded && !canTrySpeech) {
      this.error = 'Chưa có câu thoại thu sẵn hoặc giọng tiếng Việt trên trình duyệt này.';
      this.notify();
      return;
    }
    // The active line plus pending lines never exceeds three. Keep recent events.
    const capacity = this.activeVoice ? 2 : 3;
    if (this.voiceQueue.length >= capacity) this.voiceQueue.shift();
    this.voiceQueue.push(key);
    this.pumpVoice();
    this.notify();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.enabled = false;
    this.loading = false;
    this.wantsAudio = false;
    this.clearWatchdog();
    this.clearVoices();
    this.stopEffects();
    this.stopMusic();
    this.stopFallbackMusic(true);
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
    this.synthesis?.removeEventListener('voiceschanged', this.voicesChanged);
    if (this.context) {
      this.context.onstatechange = null;
      void this.context.close().catch(() => { /* The browser may have closed it already. */ });
    }
    for (const gain of Object.values(this.gains)) gain?.disconnect();
    this.compressor?.disconnect();
    this.effects.clear();
    this.voices.clear();
    this.pendingCues.length = 0;
    this.music = null;
    this.officeMusic = null;
    this.stationMusic = null;
    this.voiceAvailable = false;
    this.notify();
  }

  private createContext(): void {
    const audioWindow = window as unknown as {
      AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext;
    };
    const Context = audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
    if (!Context) throw new Error('Web Audio is unavailable');
    const context = new Context();
    this.context = context;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.knee.value = 12;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.006;
    compressor.release.value = 0.18;
    compressor.connect(context.destination);
    this.compressor = compressor;
    for (const channel of ['music', 'effects', 'voice'] as const) {
      const gain = context.createGain();
      gain.gain.value = 0;
      gain.connect(compressor);
      this.gains[channel] = gain;
    }
    context.onstatechange = () => {
      if (this.disposed) return;
      if (context.state !== 'running') {
        this.stopMusic();
        this.clearVoices();
        this.stopEffects();
        if (this.wantsAudio && !this.muted) {
          this.ensureWatchdog();
          this.syncFallbackMusic();
        }
      } else {
        this.handleContextRunning();
      }
      this.notify();
    };
  }

  private handleContextRunning(): void {
    this.clearWatchdog();
    if (!this.enabled || !this.loaded) {
      if (this.wantsAudio) void this.finishEnable();
      return;
    }
    this.stopFallbackMusic();
    this.updateGains();
    this.syncMusic();
    this.pumpVoice();
  }

  private ensureWatchdog(): void {
    if (this.disposed || this.watchdogTimer !== null) return;
    this.watchdogTimer = setInterval(() => {
      if (this.disposed || !this.wantsAudio) {
        this.clearWatchdog();
        return;
      }
      if (this.context?.state === 'running') {
        this.handleContextRunning();
        return;
      }
      if (this.context && this.context.state === 'suspended') {
        void this.context.resume().then(() => {
          if (!this.disposed && this.context?.state === 'running') {
            this.handleContextRunning();
          }
        }).catch(() => {});
      }
      if (!this.muted && this.running && this.volumes.music > 0) {
        this.syncFallbackMusic();
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private finishEnable(): Promise<void> {
    if (this.finishing) return this.finishing;
    this.finishing = this.doFinishEnable().finally(() => {
      this.finishing = null;
    });
    return this.finishing;
  }

  private async doFinishEnable(): Promise<void> {
    if (this.disposed || this.context?.state !== 'running') return;
    this.clearWatchdog();
    this.error = null;
    this.synthesisFailed = false;
    this.refreshVoices();

    if (!this.loaded || this.missingAssets.size) {
      this.loading = true;
      this.notify();
      const loadedOk = await this.loadAssets();
      if (this.disposed) return;
      this.loading = false;
      if (!loadedOk) {
        this.loaded = false;
        this.enabled = false;
        this.error = 'Chưa tải được tệp âm thanh.';
        this.notify();
        return;
      }
      this.loaded = true;
    }

    if (this.disposed || this.context?.state !== 'running') {
      this.enabled = false;
      if (!this.disposed && this.wantsAudio) {
        this.ensureWatchdog();
        this.syncFallbackMusic();
      }
      this.notify();
      return;
    }

    this.enabled = true;
    this.stopFallbackMusic();
    this.updateGains();
    this.syncMusic();
    this.flushPendingCues();
    this.pumpVoice();
    this.notify();
  }

  private async loadAssets(): Promise<boolean> {
    const context = this.context!;
    let recorded = new Set<VoiceKey>();
    try {
      const bytes = await this.fetchLocal('audio-manifest.json');
      const manifest = JSON.parse(new TextDecoder().decode(bytes)) as {
        version?: number; voices?: Partial<Record<VoiceKey, { status?: string; file?: string }>>;
      };
      if (manifest.version !== 1) throw new Error('Unsupported audio manifest');
      recorded = new Set(VOICE_KEYS.filter((key) => {
        const clip = manifest.voices?.[key];
        return clip?.status === 'recorded' && clip.file === `voice-${key}.mp3`;
      }));
      this.unavailableVoices = new Set(VOICE_KEYS.filter((key) => !recorded.has(key)));
      this.missingAssets.delete('manifest');
    } catch {
      if (!this.disposed) this.missingAssets.add('manifest');
    }
    if (this.disposed) return false;
    const load = async (name: string, filename: string, save: (buffer: AudioBuffer) => void): Promise<void> => {
      try {
        const bytes = await this.fetchLocal(filename);
        const buffer = await context.decodeAudioData(bytes);
        if (!this.disposed) { save(buffer); this.missingAssets.delete(name); }
      } catch {
        if (!this.disposed) this.missingAssets.add(name);
      }
    };
    const tasks: Promise<void>[] = [];
    if (!this.officeMusic) tasks.push(load('music', 'office-loop.wav', (buffer) => { this.officeMusic = buffer; }));
    if (!this.stationMusic) tasks.push(load('station-music', 'station-loop.wav', (buffer) => { this.stationMusic = buffer; }));
    for (const cue of CUES) {
      if (!this.effects.has(cue)) tasks.push(load(cue, `${cue}.wav`, (buffer) => { this.effects.set(cue, buffer); }));
    }
    for (const key of recorded) {
      if (!this.voices.has(key)) tasks.push(load(`voice-${key}`, `voice-${key}.mp3`, (buffer) => { this.voices.set(key, buffer); }));
    }
    await Promise.all(tasks);
    if (this.disposed) return false;
    this.music = this.scene === 'station' ? (this.stationMusic ?? this.officeMusic) : (this.officeMusic ?? this.stationMusic);
    this.refreshVoices();
    return Boolean(this.officeMusic || this.stationMusic || this.effects.size || !this.missingAssets.has('manifest'));
  }

  private async fetchLocal(filename: string): Promise<ArrayBuffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    this.requests.add(controller);
    try {
      const response = await fetch(`/audio/${filename}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`Audio HTTP ${response.status}`);
      return await response.arrayBuffer();
    } finally {
      clearTimeout(timer);
      this.requests.delete(controller);
    }
  }

  private refreshVoices(): void {
    if (this.disposed) return;
    try {
      const voices = this.synthesis?.getVoices().filter((voice) => /^vi(?:[-_]|$)/i.test(voice.lang)) ?? [];
      this.vietnameseVoice = voices.find((voice) => voice.localService && /^vi[-_]VN$/i.test(voice.lang))
        ?? voices.find((voice) => voice.localService) ?? voices[0] ?? null;
    } catch { this.vietnameseVoice = null; }
    this.voiceAvailable = this.voices.size > 0
      || (this.fallbackPlaying && this.unavailableVoices.size < VOICE_KEYS.length)
      || (this.vietnameseVoice !== null && !this.synthesisFailed);
  }

  private canPlay(): boolean {
    return !this.disposed && this.enabled && !this.muted && this.context?.state === 'running';
  }

  private updateGains(): void {
    if (this.context && this.context.state !== 'closed') {
      for (const channel of ['music', 'effects', 'voice'] as const) {
        const gain = this.gains[channel]?.gain;
        if (!gain) continue;
        const volume = this.enabled && !this.muted && !this.disposed ? this.volumes[channel] : 0;
        const target = channel === 'music' && this.activeVoice ? volume * 0.22 : volume;
        gain.cancelScheduledValues(this.context.currentTime);
        gain.setTargetAtTime(target, this.context.currentTime, target ? 0.08 : 0.008);
      }
    }
    this.syncFallbackVolumes();
  }

  private syncFallbackVolumes(): void {
    if (this.fallbackMusicEl) {
      const musicVol = !this.disposed && !this.muted && this.running ? this.volumes.music : 0;
      this.fallbackMusicEl.volume = clamp(this.activeVoice ? musicVol * 0.22 : musicVol);
    }
    if (this.fallbackVoiceEl) {
      this.fallbackVoiceEl.volume = clamp(this.muted ? 0 : this.volumes.voice);
    }
    for (const el of this.fallbackEffectEls) {
      el.volume = clamp(this.muted ? 0 : this.volumes.effects);
    }
  }

  private syncMusic(): void {
    if (this.canPlay() && this.music) {
      this.stopFallbackMusic();
      if (!this.running || !this.volumes.music) {
        this.stopMusic();
        return;
      }
      if (this.musicSource) return;
      try {
        const source = this.context!.createBufferSource();
        source.buffer = this.music;
        source.loop = true;
        source.connect(this.gains.music!);
        this.musicStartedAt = this.context!.currentTime;
        source.start(0, this.musicOffset % this.music.duration);
        this.musicSource = source;
      } catch {
        this.error = 'Chưa phát được nhạc nền.';
        this.notify();
      }
      return;
    }
    this.stopMusic();
    this.syncFallbackMusic();
  }

  private stopMusic(): void {
    if (!this.musicSource) return;
    if (this.context && this.music) {
      this.musicOffset = (this.musicOffset + Math.max(0, this.context.currentTime - this.musicStartedAt)) % this.music.duration;
    }
    try { this.musicSource.stop(); } catch { /* The node may already have ended. */ }
    this.musicSource.disconnect();
    this.musicSource = null;
  }

  private getFallbackMusicElement(): HTMLAudioElement | null {
    if (typeof Audio === 'undefined') return null;
    if (!this.fallbackMusicEl) {
      const el = new Audio();
      el.loop = true;
      el.preload = 'auto';
      el.addEventListener('playing', () => {
        if (this.disposed || (this.canPlay() && this.music)) {
          this.stopFallbackMusic();
          return;
        }
        this._fallbackMusicPlaying = true;
        this.refreshVoices();
        this.notify();
      });
      el.addEventListener('pause', () => {
        if (this._fallbackMusicPlaying) {
          this._fallbackMusicPlaying = false;
          this.refreshVoices();
          this.notify();
        }
      });
      this.fallbackMusicEl = el;
    }
    const targetScene = this.scene;
    if (this.fallbackMusicScene !== targetScene) {
      try { this.fallbackMusicEl.pause(); } catch { /* Ignore pause failure on uninitialized element. */ }
      this.fallbackMusicEl.src = targetScene === 'station' ? '/audio/station-loop.wav' : '/audio/office-loop.wav';
      this.fallbackMusicEl.currentTime = 0;
      this.fallbackMusicScene = targetScene;
    }
    this.syncFallbackVolumes();
    return this.fallbackMusicEl;
  }

  private syncFallbackMusic(): void {
    void this.tryStartFallbackMusic();
  }

  private async tryStartFallbackMusic(): Promise<boolean> {
    const webAudioReady = this.canPlay() && Boolean(this.music);
    const webAudioLoading = !this.disposed && this.context?.state === 'running' && this.loading;
    if (this.disposed || webAudioReady || !this.wantsAudio || this.muted || !this.running || this.volumes.music <= 0) {
      this.stopFallbackMusic();
      return false;
    }
    // Avoid briefly starting <audio> while a newly-running AudioContext is still finishing its initial decode.
    if (webAudioLoading && !this._fallbackMusicPlaying) return false;
    const el = this.getFallbackMusicElement();
    if (!el) return false;
    if (!el.paused) {
      this._fallbackMusicPlaying = true;
      return true;
    }
    try {
      const playPromise = el.play();
      if (playPromise && typeof playPromise.then === 'function') {
        await Promise.race([playPromise, delay(200)]);
      }
      if (this.disposed || this.muted || !this.running || (this.canPlay() && this.music)) {
        this.stopFallbackMusic();
        return false;
      }
      this._fallbackMusicPlaying = !el.paused;
      this.refreshVoices();
      this.notify();
      return this._fallbackMusicPlaying;
    } catch {
      this._fallbackMusicPlaying = false;
      return false;
    }
  }

  private stopFallbackMusic(destroy = false): void {
    const el = this.fallbackMusicEl;
    if (el && this.fallbackMusicScene === this.scene && Number.isFinite(el.currentTime) && el.currentTime > 0) {
      this.musicOffset = el.currentTime;
    }
    this._fallbackMusicPlaying = false;
    if (!el) return;
    try { el.pause(); } catch { /* Ignore pause failure during teardown. */ }
    if (destroy) {
      try {
        el.removeAttribute('src');
        el.load();
      } catch { /* Ignore cleanup failure. */ }
      this.fallbackMusicEl = null;
      this.fallbackMusicScene = null;
    }
  }

  private playFallbackEffect(cue: AudioCue, now: number): void {
    if (typeof Audio === 'undefined' || this.fallbackEffectEls.size >= 6) return;
    const el = new Audio(`/audio/${cue}.wav`);
    el.volume = clamp(this.volumes.effects);
    const cleanup = () => {
      el.onended = null;
      el.onerror = null;
      this.fallbackEffectEls.delete(el);
    };
    el.onended = cleanup;
    el.onerror = cleanup;
    this.fallbackEffectEls.add(el);
    this.lastEffect.set(cue, now);
    el.play().catch(cleanup);
  }

  private flushPendingCues(): void {
    if (!this.canPlay() || !this.pendingCues.length) return;
    const queued = this.pendingCues.splice(0, this.pendingCues.length);
    for (const cue of queued) this.play(cue);
  }

  private stopEffects(): void {
    for (const source of this.effectSources) {
      source.onended = null;
      try { source.stop(); } catch { /* Already stopped. */ }
      source.disconnect();
    }
    this.effectSources.clear();
    for (const el of this.fallbackEffectEls) {
      el.onended = null;
      el.onerror = null;
      try { el.pause(); } catch { /* Already paused. */ }
    }
    this.fallbackEffectEls.clear();
    this.pendingCues.length = 0;
  }

  private pumpVoice(): void {
    if (this.disposed || this.activeVoice || !this.wantsAudio || this.muted || !this.volumes.voice) return;
    // Wait briefly if Web Audio is running and currently finishing its initial decode.
    if (this.context?.state === 'running' && this.loading) return;
    const key = this.voiceQueue.shift();
    if (!key) return;

    const buffer = this.voices.get(key);
    const job: ActiveVoice = { key, cleanup: () => {} };
    this.activeVoice = job;
    this.lastVoice.set(key, nowSec());
    this.updateGains();

    try {
      if (this.canPlay() && buffer) {
        const source = this.context!.createBufferSource();
        source.buffer = buffer;
        source.connect(this.gains.voice!);
        job.cleanup = (cancel) => {
          source.onended = null;
          if (cancel) { try { source.stop(); } catch { /* Already ended. */ } }
          source.disconnect();
        };
        source.onended = () => this.finishVoice(job);
        job.timer = setTimeout(() => this.finishVoice(job, true), (buffer.duration + 2) * 1000);
        source.start();
      } else if (!this.unavailableVoices.has(key) && typeof Audio !== 'undefined') {
        const el = new Audio(`/audio/voice-${key}.mp3`);
        el.volume = clamp(this.volumes.voice);
        this.fallbackVoiceEl = el;
        job.cleanup = (cancel) => {
          el.onended = null;
          el.onerror = null;
          if (this.fallbackVoiceEl === el) this.fallbackVoiceEl = null;
          if (cancel) { try { el.pause(); } catch { /* Already paused. */ } }
        };
        el.onended = () => this.finishVoice(job);
        el.onerror = () => this.finishVoice(job, true);
        job.timer = setTimeout(() => this.finishVoice(job, true), 16000);
        el.play().catch(() => {
          if (this.synthesis && this.vietnameseVoice && !this.synthesisFailed && this.activeVoice === job) {
            this.fallbackVoiceEl = null;
            this.speakViaSynthesis(key, job);
            return;
          }
          this.finishVoice(job, true);
        });
      } else if (this.synthesis && this.vietnameseVoice && !this.synthesisFailed) {
        this.speakViaSynthesis(key, job);
      } else {
        throw new Error('Vietnamese speech is unavailable');
      }
    } catch {
      this.error = 'Chưa phát được lời thoại tiếng Việt.';
      this.finishVoice(job, true);
    }
    this.notify();
  }

  private speakViaSynthesis(key: VoiceKey, job: ActiveVoice): void {
    if (!this.synthesis || !this.vietnameseVoice || this.synthesisFailed) {
      throw new Error('Vietnamese speech is unavailable');
    }
    // Avoid queuing our speech behind an unrelated speaker in the same page.
    if (this.synthesis.speaking || this.synthesis.pending) throw new Error('Speech is busy');
    const utterance = new SpeechSynthesisUtterance(VOICE_TEXT[key]);
    utterance.lang = 'vi-VN';
    utterance.voice = this.vietnameseVoice;
    utterance.rate = 0.98;
    utterance.pitch = 1.02;
    utterance.volume = this.volumes.voice;
    job.cleanup = (cancel) => {
      utterance.onend = null;
      utterance.onerror = null;
      if (cancel) this.synthesis?.cancel();
    };
    utterance.onend = () => this.finishVoice(job);
    utterance.onerror = () => {
      this.synthesisFailed = true;
      this.refreshVoices();
      this.error = 'Giọng đọc tiếng Việt chưa phát được. Hãy bấm bật lại để thử.';
      this.finishVoice(job);
    };
    job.timer = setTimeout(() => this.finishVoice(job, true), 14000);
    this.synthesis.speak(utterance);
  }

  private finishVoice(job: ActiveVoice, cancel = false): void {
    if (this.activeVoice !== job) return;
    this.activeVoice = null;
    if (job.timer !== undefined) clearTimeout(job.timer);
    try { job.cleanup(cancel); } catch { /* Speech engines may disappear on navigation. */ }
    this.updateGains();
    this.pumpVoice();
    this.notify();
  }

  private clearVoices(): void {
    this.voiceQueue.length = 0;
    if (this.activeVoice) this.finishVoice(this.activeVoice, true);
  }

  private notify(): void {
    try { this.onStatus?.(this.status); } catch { /* UI callbacks must not break audio. */ }
  }
}
