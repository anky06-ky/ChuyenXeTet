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
const DEFAULT_VOLUMES = { music: 0.35, effects: 0.62, voice: 0.9 };
const clamp = (value: number): number => Math.max(0, Math.min(1, value));

interface ActiveVoice {
  key: VoiceKey;
  cleanup: (cancel: boolean) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** Local audio; nothing plays until enable() is called from a user gesture. */
export class AudioManager {
  enabled = false;
  muted = false;
  volumes: Record<AudioChannel, number> = { ...DEFAULT_VOLUMES };
  voiceAvailable = false;
  onStatus?: (status: AudioStatus) => void;

  private context: AudioContext | null = null;
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
  private effectSources = new Set<AudioBufferSourceNode>();
  private lastEffect = new Map<AudioCue, number>();
  private lastVoice = new Map<VoiceKey, number>();
  private voiceQueue: VoiceKey[] = [];
  private activeVoice: ActiveVoice | null = null;
  private synthesis: SpeechSynthesis | null = null;
  private vietnameseVoice: SpeechSynthesisVoice | null = null;
  private synthesisFailed = false;
  private running = true;
  private disposed = false;
  private loading = false;
  private loaded = false;
  private enabling: Promise<void> | null = null;
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

  get status(): AudioStatus {
    const recordedVoices = VOICE_KEYS.filter((key) => this.voices.has(key));
    const fallback = this.vietnameseVoice !== null && !this.synthesisFailed;
    const missingVoices = VOICE_KEYS.filter((key) => !this.voices.has(key) && !fallback);
    const voiceMode: VoiceMode = this.loading ? 'loading'
      : recordedVoices.length === VOICE_KEYS.length ? 'recorded'
      : recordedVoices.length ? (fallback ? 'mixed' : 'recorded')
      : fallback ? 'speech-synthesis' : 'unavailable';
    let label = !this.enabled ? 'Bấm bật âm thanh' : this.muted ? 'Đã tắt tiếng'
      : this.loading ? 'Đang tải âm thanh…' : 'Âm thanh sẵn sàng';
    if (this.enabled && !this.loading && !this.muted) {
      label += voiceMode === 'recorded' ? ` · ${recordedVoices.length}/${VOICE_KEYS.length} câu thoại thu sẵn`
        : voiceMode === 'mixed' ? ' · Có dùng giọng đọc của trình duyệt'
        : voiceMode === 'speech-synthesis' ? ' · Giọng đọc tiếng Việt của trình duyệt'
        : ' · Chưa có giọng tiếng Việt';
      if (this.missingAssets.size) label += ' · Một số tệp âm thanh chưa tải được';
      if (this.context && this.context.state !== 'running') label = 'Âm thanh tạm dừng · Bấm bật lại';
    }
    if (this.disposed) label = 'Đã đóng âm thanh';
    return {
      enabled: this.enabled, muted: this.muted, running: this.running, loading: this.loading,
      volumes: { ...this.volumes }, voiceAvailable: this.voiceAvailable, voiceMode,
      recordedVoices, missingVoices,
      speechRequiresNetwork: fallback && !this.vietnameseVoice!.localService,
      speaking: this.activeVoice?.key ?? null, queuedVoices: this.voiceQueue.length,
      missingAssets: [...this.missingAssets], error: this.error, label,
    };
  }

  /** Call directly from a click/tap handler, before awaiting any other work. */
  async enable(options: { autoplay?: boolean } = {}): Promise<void> {
    if (this.disposed) return;
    if (this.enabling) return this.enabling;
    const activation = typeof navigator !== 'undefined' ? navigator.userActivation : undefined;
    if (!options.autoplay && !this.enabled && activation && !activation.isActive) {
      this.error = 'Hãy bấm nút bật âm thanh để trình duyệt cho phép phát.';
      this.notify();
      return;
    }
    try {
      if (!this.context) this.createContext();
      // OBS and TikTok LIVE Studio browser sources start audio without a click. Elsewhere a
      // fresh context is suspended; never wait on resume() then, because it may not settle.
      if (options.autoplay && this.context!.state !== 'running') { this.notify(); return; }
      // resume() must happen in the original gesture, before any fetch/await.
      const resume = this.context!.resume();
      this.enabling = this.finishEnable(resume).catch(() => {
        if (this.disposed) return;
        this.enabled = false;
        this.loading = false;
        this.error = 'Trình duyệt chưa cho phát âm thanh. Hãy bấm bật lại.';
        this.notify();
      });
      await this.enabling;
    } catch {
      this.enabled = false;
      this.loading = false;
      this.error = 'Trình duyệt chưa cho phát âm thanh. Hãy bấm bật lại.';
      this.notify();
    } finally {
      this.enabling = null;
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
      this.syncMusic();
      this.updateGains();
      this.notify();
    }
  }

  play(cue: AudioCue): void {
    if (!this.canPlay() || !this.volumes.effects || this.effectSources.size >= 6) return;
    const buffer = this.effects.get(cue);
    const context = this.context!;
    const previous = this.lastEffect.get(cue);
    if (!buffer || (previous !== undefined && context.currentTime - previous < COOLDOWN[cue])) return;
    let source: AudioBufferSourceNode | null = null;
    try {
      source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.gains.effects!);
      const node = source;
      node.onended = () => {
        this.effectSources.delete(node);
        node.disconnect();
      };
      this.effectSources.add(node);
      source.start();
      this.lastEffect.set(cue, context.currentTime);
    } catch {
      if (source) { this.effectSources.delete(source); source.disconnect(); }
      this.error = 'Chưa phát được hiệu ứng âm thanh.';
      this.notify();
    }
  }

  say(key: VoiceKey): void {
    if (!this.canPlay() || !this.volumes.voice || !VOICE_KEYS.includes(key)) return;
    if (this.activeVoice?.key === key || this.voiceQueue.includes(key)) return;
    const previous = this.lastVoice.get(key);
    if (previous !== undefined && this.context!.currentTime - previous < 4) return;
    if (!this.voices.has(key) && (!this.vietnameseVoice || this.synthesisFailed)) {
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
    this.clearVoices();
    this.stopEffects();
    this.stopMusic();
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
      if (context.state !== 'running') { this.clearVoices(); this.stopEffects(); }
      this.notify();
    };
  }

  private async finishEnable(resume: Promise<void>): Promise<void> {
    await resume;
    if (this.disposed) return;
    if (this.context?.state !== 'running') throw new Error('Audio context is suspended');
    this.enabled = true;
    this.error = null;
    this.synthesisFailed = false;
    this.refreshVoices();
    if (!this.loaded || this.missingAssets.size) {
      this.loading = true;
      this.notify();
      await this.loadAssets();
      if (this.disposed) return;
      this.loading = false;
      this.loaded = true;
    }
    this.updateGains();
    this.syncMusic();
    this.notify();
  }

  private async loadAssets(): Promise<void> {
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
      this.missingAssets.delete('manifest');
    } catch {
      if (!this.disposed) this.missingAssets.add('manifest');
    }
    if (this.disposed) return;
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
    this.music = this.scene === 'station' ? (this.stationMusic ?? this.officeMusic) : (this.officeMusic ?? this.stationMusic);
    this.refreshVoices();
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
    this.voiceAvailable = this.voices.size > 0 || (this.vietnameseVoice !== null && !this.synthesisFailed);
  }

  private canPlay(): boolean {
    return !this.disposed && this.enabled && !this.muted && this.context?.state === 'running';
  }

  private updateGains(): void {
    if (!this.context || this.context.state === 'closed') return;
    for (const channel of ['music', 'effects', 'voice'] as const) {
      const gain = this.gains[channel]?.gain;
      if (!gain) continue;
      const volume = this.enabled && !this.muted && !this.disposed ? this.volumes[channel] : 0;
      const target = channel === 'music' && this.activeVoice ? volume * 0.22 : volume;
      gain.cancelScheduledValues(this.context.currentTime);
      gain.setTargetAtTime(target, this.context.currentTime, target ? 0.08 : 0.008);
    }
  }

  private syncMusic(): void {
    if (!this.canPlay() || !this.running || !this.volumes.music || !this.music) {
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

  private stopEffects(): void {
    for (const source of this.effectSources) {
      source.onended = null;
      try { source.stop(); } catch { /* Already stopped. */ }
      source.disconnect();
    }
    this.effectSources.clear();
  }

  private pumpVoice(): void {
    if (this.activeVoice || !this.canPlay() || !this.volumes.voice) return;
    const key = this.voiceQueue.shift();
    if (!key) return;
    const buffer = this.voices.get(key);
    const job: ActiveVoice = { key, cleanup: () => {} };
    this.activeVoice = job;
    this.lastVoice.set(key, this.context!.currentTime);
    this.updateGains();
    try {
      if (buffer) {
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
      } else if (this.synthesis && this.vietnameseVoice && !this.synthesisFailed) {
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
      } else {
        throw new Error('Vietnamese speech is unavailable');
      }
    } catch {
      this.error = 'Chưa phát được lời thoại tiếng Việt.';
      this.finishVoice(job, true);
    }
    this.notify();
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
