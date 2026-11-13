import Phaser from 'phaser';

export const FONT = '"Be Vietnam Pro", sans-serif';
const FACE_COLORS = ['#8f7aa6', '#6f8a66', '#b07f56', '#b07884'];
const MAX_FACES = 260;

export type FaceOwner = { nickname: string; skin: number; avatar: string };

const canvas = (width: number, height: number) => Object.assign(document.createElement('canvas'), { width, height });

/**
 * Circular profile pictures shared by every scene of one game.
 * TikTok images come through the local /api/avatar cache and are clipped once
 * into a canvas texture; until then (or when they fail) an initial is shown.
 */
export class Faces {
  private keys = new Map<string, string | null>();
  private failed = new Set<string>();
  private seq = 0;
  private listeners = new Set<(url: string, key: string) => void>();
  private users = new Set<() => Iterable<string>>();

  constructor(private readonly textures: Phaser.Textures.TextureManager) {}

  /** Report which avatar URLs a scene currently displays, so pruning never removes them. */
  use(provider: () => Iterable<string>) { this.users.add(provider); return () => this.users.delete(provider); }
  onReady(listener: (url: string, key: string) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  initials(owner: FaceOwner) {
    const letter = ([...owner.nickname.trim()][0] || 'T').toUpperCase();
    const key = `ini_${owner.skin % 4}_${letter}`;
    if (!this.textures.exists(key)) {
      const face = canvas(96, 96);
      const g = face.getContext('2d')!;
      g.fillStyle = FACE_COLORS[owner.skin % 4];
      g.beginPath(); g.arc(48, 48, 46, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff8ec'; g.font = `700 46px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(letter, 48, 52);
      this.textures.addCanvas(key, face);
    }
    return key;
  }

  key(owner: FaceOwner) {
    const url = owner.avatar;
    if (!url || this.failed.has(url)) return this.initials(owner);
    const ready = this.keys.get(url);
    if (ready && this.textures.exists(ready)) return ready;
    if (!this.keys.has(url) || ready) this.load(url);
    return this.initials(owner);
  }

  private load(url: string) {
    this.keys.set(url, null);
    if (this.keys.size > MAX_FACES) this.prune();
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      if (!this.keys.has(url) || !image.naturalWidth) return;
      const face = canvas(96, 96);
      const g = face.getContext('2d')!;
      g.beginPath(); g.arc(48, 48, 46, 0, Math.PI * 2); g.clip();
      const fit = Math.max(96 / image.naturalWidth, 96 / image.naturalHeight);
      g.drawImage(image, (96 - image.naturalWidth * fit) / 2, (96 - image.naturalHeight * fit) / 2, image.naturalWidth * fit, image.naturalHeight * fit);
      const key = `face_${++this.seq}`;
      this.textures.addCanvas(key, face);
      this.keys.set(url, key);
      for (const listener of this.listeners) listener(url, key);
    };
    image.onerror = () => { this.keys.delete(url); this.failed.add(url); if (this.failed.size > 500) this.failed.clear(); };
    image.src = `/api/avatar?u=${encodeURIComponent(url)}`;
  }

  private prune() {
    const used = new Set<string>();
    for (const provider of this.users) for (const url of provider()) used.add(url);
    for (const [url, key] of this.keys) {
      if (used.has(url)) continue;
      this.keys.delete(url);
      // Remove later in the frame so no game object renders a texture that just vanished.
      if (key && this.textures.exists(key)) queueMicrotask(() => { if (this.textures.exists(key)) this.textures.remove(key); });
    }
  }
}

const shared = new WeakMap<Phaser.Game, Faces>();
export function facesFor(game: Phaser.Game) {
  let faces = shared.get(game);
  if (!faces) { faces = new Faces(game.textures); shared.set(game, faces); }
  return faces;
}

export const shortName = (name: string, limit = 9) => { const chars = [...name.trim()]; return chars.length > limit ? chars.slice(0, limit - 1).join('').trimEnd() + '…' : chars.join(''); };
export const makeCanvas = canvas;
