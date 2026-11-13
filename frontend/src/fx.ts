import Phaser from 'phaser';
import { FONT, makeCanvas } from './faces';

const MAX_FX = 180;

/** Small textures shared by every scene. Safe to call more than once. */
export function ensureFxTextures(textures: Phaser.Textures.TextureManager) {
  if (!textures.exists('heart')) {
    const heart = makeCanvas(44, 40);
    const h = heart.getContext('2d')!;
    h.fillStyle = '#ff4d6d';
    h.beginPath(); h.moveTo(22, 38); h.bezierCurveTo(-6, 20, 4, -4, 22, 10); h.bezierCurveTo(40, -4, 50, 20, 22, 38); h.fill();
    h.fillStyle = 'rgba(255,255,255,.55)'; h.beginPath(); h.ellipse(13, 12, 5, 3.5, -0.6, 0, Math.PI * 2); h.fill();
    textures.addCanvas('heart', heart);
  }
  if (!textures.exists('coin')) {
    const coin = makeCanvas(40, 40);
    const c = coin.getContext('2d')!;
    const shine = c.createRadialGradient(15, 13, 2, 20, 20, 20);
    shine.addColorStop(0, '#fff3b8'); shine.addColorStop(0.6, '#f2b632'); shine.addColorStop(1, '#a8670d');
    c.fillStyle = shine; c.beginPath(); c.arc(20, 20, 18, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#7a4806'; c.lineWidth = 2; c.stroke();
    c.fillStyle = '#7a4806'; c.fillRect(15, 15, 10, 10);
    textures.addCanvas('coin', coin);
  }
  if (!textures.exists('spark')) {
    const spark = makeCanvas(32, 32);
    const s = spark.getContext('2d')!;
    const glow = s.createRadialGradient(16, 16, 0, 16, 16, 16);
    glow.addColorStop(0, 'rgba(255,255,235,1)'); glow.addColorStop(0.35, 'rgba(255,214,110,.9)'); glow.addColorStop(1, 'rgba(255,170,60,0)');
    s.fillStyle = glow; s.fillRect(0, 0, 32, 32);
    textures.addCanvas('spark', spark);
  }
  if (!textures.exists('petal')) {
    const petal = makeCanvas(16, 22);
    const p = petal.getContext('2d')!;
    p.fillStyle = '#f4a6b4'; p.beginPath(); p.ellipse(8, 11, 6, 10, 0.3, 0, Math.PI * 2); p.fill();
    textures.addCanvas('petal', petal);
  }
  if (!textures.exists('puff')) {
    const puff = makeCanvas(48, 48);
    const p = puff.getContext('2d')!;
    const smoke = p.createRadialGradient(24, 24, 2, 24, 24, 24);
    smoke.addColorStop(0, 'rgba(235,232,228,.85)'); smoke.addColorStop(1, 'rgba(200,196,190,0)');
    p.fillStyle = smoke; p.fillRect(0, 0, 48, 48);
    textures.addCanvas('puff', puff);
  }
}

/** Short-lived celebration sprites with a hard cap so a busy LIVE never piles up objects. */
export class Effects {
  private count = 0;

  constructor(private readonly scene: Phaser.Scene) {}

  private piece(key: string, x: number, y: number) {
    if (this.count >= MAX_FX) return undefined;
    this.count++;
    return this.scene.add.image(x, y, key).setDepth(6500).once('destroy', () => { this.count--; });
  }

  floatText(x: number, y: number, text: string, color = '#3f7d4f', size = 30) {
    const label = this.scene.add.text(x, y, text, { fontFamily: FONT, fontSize: `${size}px`, fontStyle: '700', color, stroke: '#fff8ea', strokeThickness: 7 }).setOrigin(0.5).setDepth(7000);
    this.scene.tweens.add({ targets: label, y: y - 90, alpha: 0, delay: 900, duration: 900, onComplete: () => label.destroy() });
  }

  hearts(x: number, y: number, count: number) {
    for (let index = 0; index < count; index++) {
      const heart = this.piece('heart', x + (Math.random() - 0.5) * 50, y);
      if (!heart) return;
      heart.setScale(0.5 + Math.random() * 0.5).setAlpha(0.95);
      this.scene.tweens.add({ targets: heart, y: y - 180 - Math.random() * 120, x: `+=${(Math.random() - 0.5) * 120}`, scale: heart.scale * 1.3, alpha: 0, angle: (Math.random() - 0.5) * 40, delay: index * 90, duration: 1500 + Math.random() * 600, onComplete: () => heart.destroy() });
    }
  }

  burst(x: number, y: number, key: 'coin' | 'spark' | 'puff', count: number, radius = 140) {
    for (let index = 0; index < count; index++) {
      const piece = this.piece(key, x, y);
      if (!piece) return;
      const angle = (index / count) * Math.PI * 2 + Math.random() * 0.4;
      const distance = radius * (0.6 + Math.random() * 0.5);
      piece.setScale(key === 'coin' ? 0.7 : key === 'puff' ? 1.4 : 1.1);
      this.scene.tweens.add({ targets: piece, x: x + Math.cos(angle) * distance, y: y + Math.sin(angle) * distance + (key === 'coin' ? 60 : 0), alpha: 0, scale: key === 'coin' ? 0.5 : key === 'puff' ? 2.2 : 0.3, duration: 900 + Math.random() * 400, ease: 'Cubic.easeOut', onComplete: () => piece.destroy() });
    }
  }

  confetti(count: number) {
    const colors = [0xd8452f, 0xf2c14e, 0x8b83b6, 0x7fa37a, 0xf08aa0];
    for (let index = 0; index < count; index++) {
      if (this.count >= MAX_FX) return;
      this.count++;
      const piece = this.scene.add.rectangle(60 + Math.random() * 960, 220 - Math.random() * 120, 12, 22, colors[index % colors.length]).setAngle(index * 23).setDepth(6600).once('destroy', () => { this.count--; });
      this.scene.tweens.add({ targets: piece, y: 1450 + Math.random() * 200, x: `+=${(Math.random() - 0.5) * 200}`, angle: `+=${200 + index * 9}`, alpha: 0, duration: 2600 + Math.random() * 1400, delay: index * 22, onComplete: () => piece.destroy() });
    }
  }

  fireworks(times: number) {
    for (let index = 0; index < times; index++) {
      this.scene.time.delayedCall(index * 420, () => this.burst(220 + Math.random() * 640, 560 + Math.random() * 380, 'spark', 18, 170));
    }
  }
}
