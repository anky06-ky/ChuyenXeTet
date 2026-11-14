import Phaser from 'phaser';

export const FONT = '"Be Vietnam Pro", sans-serif';
export const FACE_CANVAS_SIZE = 180;
const FACE_COLORS = ['#8f7aa6', '#6f8a66', '#b07f56', '#b07884'];
const MAX_FACES = 260;

export type FaceOwner = { nickname: string; skin: number; avatar: string };

export const makeCanvas = (width: number, height: number) => {
  const element = Object.assign(document.createElement('canvas'), { width, height });
  const ctx = element.getContext('2d');
  if (ctx) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
  }
  return element;
};

/** Wait for embedded Vietnamese fonts before drawing Canvas2D or Phaser Text objects. */
export function waitForFonts(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return Promise.resolve();
  return Promise.all([
    document.fonts.load(`700 20px ${FONT}`, 'Đồng nghiệp ạếộữ'),
    document.fonts.load(`600 20px ${FONT}`, 'Đồng nghiệp ạếộữ'),
    document.fonts.load('700 24px "Baloo 2", sans-serif', 'BẾN XE VỀ QUÊ'),
  ]).then(() => undefined).catch(() => undefined);
}

/** Progressive 0.5x step-down so large artwork (1254px) scales cleanly without aliasing. */
export function ensureScaledTexture(
  textures: Phaser.Textures.TextureManager,
  sourceKey: string,
  targetKey: string,
  targetSize: number,
): string {
  if (textures.exists(targetKey)) return targetKey;
  if (!textures.exists(sourceKey)) return sourceKey;
  const source = textures.get(sourceKey).getSourceImage() as HTMLImageElement | HTMLCanvasElement;
  const sw = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const sh = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
  if (!sw || !sh) return sourceKey;
  let current: HTMLImageElement | HTMLCanvasElement = source;
  let cw = sw;
  let ch = sh;
  while (cw > targetSize * 2 || ch > targetSize * 2) {
    const nw = Math.max(targetSize, Math.round(cw * 0.5));
    const nh = Math.max(targetSize, Math.round(ch * 0.5));
    const step = makeCanvas(nw, nh);
    step.getContext('2d')!.drawImage(current, 0, 0, nw, nh);
    current = step;
    cw = nw;
    ch = nh;
  }
  const out = makeCanvas(targetSize, targetSize);
  out.getContext('2d')!.drawImage(current, 0, 0, targetSize, targetSize);
  textures.addCanvas(targetKey, out);
  return targetKey;
}

function paintAvatarBorder(g: CanvasRenderingContext2D, center: number, radius: number) {
  g.save();
  g.beginPath();
  g.arc(center, center, radius - 2.5, 0, Math.PI * 2);
  g.lineWidth = 5;
  g.strokeStyle = 'rgba(255, 245, 227, 0.96)';
  g.stroke();
  g.beginPath();
  g.arc(center, center, radius + 0.5, 0, Math.PI * 2);
  g.lineWidth = 1.5;
  g.strokeStyle = 'rgba(56, 18, 8, 0.28)';
  g.stroke();
  g.restore();
}

function drawCrispCover(g: CanvasRenderingContext2D, image: HTMLImageElement, size: number) {
  let source: HTMLImageElement | HTMLCanvasElement = image;
  let sw = image.naturalWidth;
  let sh = image.naturalHeight;
  while (sw > size * 2 && sh > size * 2) {
    const nw = Math.max(size, Math.round(sw * 0.5));
    const nh = Math.max(size, Math.round(sh * 0.5));
    const step = makeCanvas(nw, nh);
    step.getContext('2d')!.drawImage(source, 0, 0, nw, nh);
    source = step;
    sw = nw;
    sh = nh;
  }
  const fit = Math.max(size / sw, size / sh);
  g.drawImage(source, (size - sw * fit) / 2, (size - sh * fit) / 2, sw * fit, sh * fit);
}

/**
 * Circular profile pictures shared by every scene of one game.
 * TikTok images come through the local /api/avatar cache and are clipped once
 * into a 180×180 canvas texture; until then (or when they fail) an initial is shown.
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
      const size = FACE_CANVAS_SIZE;
      const center = size / 2;
      const radius = center - 6;
      const face = makeCanvas(size, size);
      const g = face.getContext('2d')!;
      g.fillStyle = FACE_COLORS[owner.skin % 4];
      g.beginPath(); g.arc(center, center, radius, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff8ec'; g.font = `700 84px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(letter, center, center + 5);
      paintAvatarBorder(g, center, radius);
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
      const size = FACE_CANVAS_SIZE;
      const center = size / 2;
      const radius = center - 6;
      const face = makeCanvas(size, size);
      const g = face.getContext('2d')!;
      g.save();
      g.beginPath(); g.arc(center, center, radius, 0, Math.PI * 2); g.clip();
      drawCrispCover(g, image, size);
      g.restore();
      paintAvatarBorder(g, center, radius);
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
