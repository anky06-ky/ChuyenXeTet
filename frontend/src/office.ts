import Phaser from 'phaser';
import { FONT, ensureScaledTexture, facesFor, makeCanvas, shortName, waitForFonts, type Faces } from './faces';
import { ensureFxTextures } from './fx';
import { StationScene } from './station';
import type { GameResult, GameState, Player } from './types';

export const STAGE_W = 1080;
export const STAGE_H = 1920;
const DOOR = { x: 540, y: 2020 };
const COFFEE = { x: 540, y: 800 };
const HEARTS_SPOT = { x: 930, y: 1330 };
const FIGURE = 150;
const FACE = 52;
const FACE_Y = 202;       // face centre above the feet
const NAME_Y = 160;       // name pill centre above the feet
const SKIN_TINT = [0xffffff, 0xffffff, 0xffe9d3, 0xe7e6ff];
const RECEPTION: Player = { id: '__reception__', nickname: 'Nhân sự · NPC', skin: 1, kpi: 0, coins: 0, xp: 0, last_work: 0, last_seen: 0, mission_works: 0, missions_completed: 0, avatar: '', hearts: 0, gifts: 0, followed: 0 };
const MAX_FX = 180;

type Avatar = {
  root: Phaser.GameObjects.Container;
  sprite: Phaser.GameObjects.Image;
  tag: Phaser.GameObjects.Container;
  face: Phaser.GameObjects.Image;
  ring: Phaser.GameObjects.Graphics;
  crown: Phaser.GameObjects.Graphics;
  label: Phaser.GameObjects.Text;
  pill: Phaser.GameObjects.Graphics;
  bubble?: Phaser.GameObjects.Container;
  bubbleTimer?: Phaser.Time.TimerEvent;
  player: Player;
  x: number;
  y: number;
  away: boolean;
};

export class OfficeScene extends Phaser.Scene {
  private avatars = new Map<string, Avatar>();
  private leaving = new Set<Avatar>();
  private order: string[] = [];
  private pendingState?: GameState;
  private ready = false;
  private desks?: Phaser.GameObjects.Container;
  private lastLayout = '';
  private faces!: Faces;
  private releaseFaces?: () => void;
  private releaseReady?: () => void;
  private fx = 0;
  onSelect?: (player: Player) => void;
  onCreated?: () => void;

  constructor() { super('office'); }

  preload() {
    this.load.image('office', '/assets/office.png');
    this.load.image('boy', '/assets/boy.png');
    this.load.image('girl', '/assets/girl.png');
  }

  create() {
    this.faces = facesFor(this.game);
    ensureScaledTexture(this.textures, 'boy', 'boy_office', FIGURE * 2);
    ensureScaledTexture(this.textures, 'girl', 'girl_office', FIGURE * 2);
    this.buildRoom();
    this.add.image(0, 0, 'room').setOrigin(0, 0).setDepth(0);
    ensureFxTextures(this.textures);
    this.releaseFaces = this.faces.use(() => Array.from(this.avatars.values(), avatar => avatar.player.avatar).filter(Boolean));
    this.releaseReady = this.faces.onReady((url, key) => {
      for (const avatar of this.avatars.values()) {
        if (avatar.player.avatar === url) avatar.face.setTexture(key).setDisplaySize(FACE, FACE);
      }
    });
    this.events.once('shutdown', () => { this.releaseFaces?.(); this.releaseReady?.(); });
    this.drawCoffeeCorner();
    this.desks = this.add.container(0, 0);
    for (let index = 0; index < 9; index++) {
      const petal = this.add.image(60 + index * 120, 250 + (index % 3) * 60, 'petal').setDepth(4000).setAlpha(0.75).setScale(0.8 + (index % 3) * 0.2);
      this.tweens.add({ targets: petal, y: 1500, x: `+=${70 - index * 16}`, angle: 300, alpha: 0, duration: 12000 + index * 1400, delay: index * 900, repeat: -1, onRepeat: () => { petal.y = 250; petal.alpha = 0.75; } });
    }
    for (let index = 0; index < 3; index++) {
      const steam = this.add.image(COFFEE.x - 10 + index * 10, COFFEE.y - 54, 'puff').setDepth(12 + COFFEE.y).setScale(0.45).setAlpha(0.45);
      this.tweens.add({ targets: steam, y: COFFEE.y - 105, x: `+=${(index - 1) * 14}`, scale: 0.9, alpha: 0, duration: 2400 + index * 350, delay: index * 700, repeat: -1, onRepeat: () => { steam.setPosition(COFFEE.x - 10 + index * 10, COFFEE.y - 54).setScale(0.45).setAlpha(0.45); } });
    }
    this.onCreated?.();
    // Names are drawn on canvas: wait for the Vietnamese subset so diacritics never fall back.
    void waitForFonts().finally(() => {
      this.ready = true;
      if (this.pendingState) this.applyState(this.pendingState);
    });
  }

  /** One static texture: the painted office, a mirrored floor extension and gradients for TikTok's own UI. */
  private buildRoom() {
    if (this.textures.exists('room')) return;
    const source = this.textures.get('office').getSourceImage() as HTMLImageElement;
    const room = makeCanvas(STAGE_W, STAGE_H);
    const g = room.getContext('2d')!;
    const scale = 1.06;
    const width = source.width * scale;
    const height = source.height * scale;
    const left = (STAGE_W - width) / 2;
    g.fillStyle = '#c98a55';
    g.fillRect(0, 0, STAGE_W, STAGE_H);
    g.drawImage(source, left, 0, width, height);
    const strip = STAGE_H - height;
    if (strip > 0) {
      g.save();
      g.translate(0, height * 2);
      g.scale(1, -1);
      g.drawImage(source, 0, source.height - strip / scale, source.width, strip / scale, left, height - strip, width, strip);
      g.restore();
    }
    // A red runner from the door to the desks.
    g.save();
    g.beginPath();
    g.moveTo(474, 1500); g.lineTo(606, 1500); g.lineTo(700, STAGE_H); g.lineTo(380, STAGE_H); g.closePath();
    const rug = g.createLinearGradient(0, 1500, 0, STAGE_H);
    rug.addColorStop(0, '#a8352a'); rug.addColorStop(1, '#7d2019');
    g.fillStyle = rug; g.fill();
    g.strokeStyle = '#e8b55a'; g.lineWidth = 6; g.stroke();
    g.restore();
    const top = g.createLinearGradient(0, 0, 0, 250);
    top.addColorStop(0, 'rgba(46,16,8,.42)'); top.addColorStop(1, 'rgba(46,16,8,0)');
    g.fillStyle = top; g.fillRect(0, 0, STAGE_W, 250);
    const bottom = g.createLinearGradient(0, 1380, 0, STAGE_H);
    bottom.addColorStop(0, 'rgba(30,10,5,0)'); bottom.addColorStop(1, 'rgba(30,10,5,.74)');
    g.fillStyle = bottom; g.fillRect(0, 1380, STAGE_W, STAGE_H - 1380);
    this.textures.addCanvas('room', room);
  }

  private drawCoffeeCorner() {
    const g = this.add.graphics({ x: COFFEE.x, y: COFFEE.y }).setDepth(10 + COFFEE.y);
    g.fillStyle(0x4a2a17, 0.22).fillEllipse(0, 34, 150, 26);
    g.fillStyle(0x8a5a3a).fillRoundedRect(-8, -2, 16, 36, 4).fillRoundedRect(-40, 28, 80, 8, 4);
    g.fillStyle(0xb8805a).fillEllipse(0, -6, 150, 34);
    g.fillStyle(0xe7c08f).fillEllipse(0, -10, 146, 28);
    g.fillStyle(0xfdf6ea).fillRoundedRect(-52, -30, 20, 20, 4).fillRoundedRect(28, -30, 20, 20, 4);
    g.fillStyle(0x7b4a2c).fillRect(-49, -27, 14, 4).fillRect(31, -27, 14, 4);
    g.fillStyle(0xb64a36).fillRoundedRect(-14, -46, 28, 36, 8);
    g.fillStyle(0x3d2a20).fillRect(-6, -52, 12, 7);
    this.add.text(COFFEE.x, COFFEE.y - 78, 'GÓC CÀ PHÊ', { fontFamily: FONT, fontSize: '17px', fontStyle: '700', color: '#fff3dc', backgroundColor: '#6b2a1bcc', padding: { x: 10, y: 4 }, resolution: 2 }).setOrigin(0.5).setDepth(10 + COFFEE.y);
  }

  private slot(index: number, count: number) {
    if (count <= 1) return { x: 540, y: 1270 };
    const rows = Math.ceil(count / 6);
    const columns = Math.ceil(count / rows);
    const spacing = Math.min(170, 680 / Math.max(1, columns - 1));
    const row = Math.floor(index / columns);
    const inRow = Math.min(columns, count - row * columns);
    // Faces of the first row must clear the side boards (they end at y≈864).
    const gap = rows >= 4 ? 114 : 132;
    const top = 1292 - (rows - 1) * gap / 2;
    const stagger = rows > 1 ? (row % 2 ? 0.25 : -0.25) * spacing : 0;
    return { x: Math.round(540 + (index % columns - (inRow - 1) / 2) * spacing + stagger), y: Math.round(top + row * gap) };
  }

  private drawDesks(slots: { x: number; y: number }[]) {
    this.desks?.removeAll(true);
    for (const { x, y } of slots) {
      // The desk sits in front of its colleague: depth just above the character.
      const g = this.add.graphics({ x, y }).setDepth(11 + y);
      g.fillStyle(0x4a2a17, 0.2).fillEllipse(0, 4, 136, 22);
      g.fillStyle(0x8f5c3b).fillRoundedRect(-58, -52, 116, 50, 6);
      g.fillStyle(0xa86f48).fillRoundedRect(-54, -46, 108, 38, 5);
      g.fillStyle(0xe8c49a).fillRoundedRect(-63, -62, 126, 14, 6);
      g.fillStyle(0x6d4530).fillRect(-52, -2, 8, 6).fillRect(44, -2, 8, 6);
      g.fillStyle(0x5d5568).fillRoundedRect(14, -86, 40, 26, 4);
      g.fillStyle(0xd9d4e6, 0.9).fillCircle(34, -73, 4);
      g.fillStyle(0xfdf6ea).fillRoundedRect(-50, -76, 14, 15, 3);
      g.fillStyle(0xd8b25a).fillRect(-20, -54, 40, 4);
      this.desks?.add(g);
    }
  }

  private paintTag(avatar: Avatar, leader: boolean) {
    const { player, label, pill, ring, crown } = avatar;
    label.setText(shortName(player.nickname, player.id === RECEPTION.id ? 14 : 9));
    const width = Math.max(58, Math.ceil(label.width + 22));
    const demo = player.id.startsWith('demo_');
    pill.clear();
    pill.fillStyle(demo ? 0x4a3a32 : 0x5c1b10, 0.92).fillRoundedRect(-width / 2, -NAME_Y - 16, width, 32, 16);
    pill.lineStyle(2, player.followed ? 0xf6cf6b : 0xf3dfc0, player.followed ? 1 : 0.75).strokeRoundedRect(-width / 2, -NAME_Y - 16, width, 32, 16);
    label.setPosition(0, -NAME_Y);
    ring.clear();
    ring.lineStyle(player.followed ? 4.5 : 3, player.followed ? 0xf6cf6b : 0xfff3dc, 1).strokeCircle(0, -FACE_Y, FACE / 2 + 1);
    crown.setVisible(leader && player.kpi > 0);
  }

  private createAvatar(player: Player, x: number, y: number, delay: number): Avatar {
    const shadow = this.add.ellipse(0, 2, 70, 16, 0x3b2418, 0.25);
    const sprite = this.add.image(0, 0, player.skin % 2 ? 'girl_office' : 'boy_office').setOrigin(0.5, 1).setDisplaySize(FIGURE, FIGURE).setTint(SKIN_TINT[player.skin % 4]);
    const root = this.add.container(DOOR.x, DOOR.y, [shadow, sprite]).setDepth(10 + DOOR.y);
    const pill = this.add.graphics();
    const label = this.add.text(0, -NAME_Y, '', { fontFamily: FONT, fontSize: '18px', fontStyle: '700', color: '#fff6e3', stroke: '#3a1008', strokeThickness: 2, resolution: 2 }).setOrigin(0.5, 0.5);
    const face = this.add.image(0, -FACE_Y, this.faces.key(player)).setDisplaySize(FACE, FACE);
    const ring = this.add.graphics();
    // Drawn, not an emoji: OBS machines do not always ship a colour emoji font.
    const crown = this.add.graphics({ x: 0, y: -FACE_Y - FACE / 2 - 2 }).setVisible(false);
    crown.fillStyle(0xf6c445).fillTriangle(-16, 0, -16, -18, -6, -6).fillTriangle(-8, 0, 0, -22, 8, 0).fillTriangle(16, 0, 16, -18, 6, -6).fillRect(-16, -4, 32, 6);
    crown.lineStyle(2, 0x9a5b0c).strokeRect(-16, -4, 32, 6);
    crown.fillStyle(0xd8452f).fillCircle(0, -1, 2.5);
    const tag = this.add.container(DOOR.x, DOOR.y, [pill, label, face, ring, crown]).setDepth(5000 + DOOR.y);
    const avatar: Avatar = { root, sprite, tag, face, ring, crown, label, pill, player, x, y, away: false };
    if (player.id !== RECEPTION.id) {
      root.setInteractive(new Phaser.Geom.Rectangle(-45, -FIGURE, 90, FIGURE + 10), Phaser.Geom.Rectangle.Contains).on('pointerdown', () => this.onSelect?.(avatar.player));
    }
    this.walk(avatar, x, y, 1100 + delay);
    this.tweens.add({ targets: sprite, y: -3, duration: 1100 + Math.random() * 500, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    return avatar;
  }

  applyState(state: GameState, event?: GameResult) {
    this.pendingState = state;
    if (!this.ready) return;
    const visible = state.players.length ? state.players : [RECEPTION];
    const byId = new Map(visible.map(player => [player.id, player]));
    this.order = [...this.order.filter(id => byId.has(id)), ...visible.map(player => player.id).filter(id => !this.order.includes(id))];
    const slots = this.order.map((_, index) => this.slot(index, this.order.length));
    const layout = slots.map(slot => `${Math.round(slot.x)},${Math.round(slot.y)}`).join('|');
    if (layout !== this.lastLayout) {
      this.drawDesks(state.players.length ? slots : []);
      this.lastLayout = layout;
    }
    for (const [id, avatar] of this.avatars) {
      if (!byId.has(id)) { this.avatars.delete(id); this.leave(avatar); }
    }
    const leader = [...state.players].sort((a, b) => b.kpi - a.kpi)[0]?.id;
    this.order.forEach((id, index) => {
      const player = byId.get(id)!;
      const target = slots[index];
      let avatar = this.avatars.get(id);
      if (!avatar) {
        avatar = this.createAvatar(player, target.x, target.y, index * 35);
        this.avatars.set(id, avatar);
      } else {
        const previous = avatar.player;
        avatar.player = player;
        if (previous.skin !== player.skin) {
          avatar.sprite.setTexture(player.skin % 2 ? 'girl_office' : 'boy_office').setDisplaySize(FIGURE, FIGURE).setTint(SKIN_TINT[player.skin % 4]);
          this.burst(avatar.root.x, avatar.root.y - 80, 'spark', 10, 90);
        }
        if (previous.avatar !== player.avatar || previous.skin !== player.skin || previous.nickname !== player.nickname) avatar.face.setTexture(this.faces.key(player)).setDisplaySize(FACE, FACE);
        if ((avatar.x !== target.x || avatar.y !== target.y) && !avatar.away) this.walk(avatar, target.x, target.y);
        avatar.x = target.x;
        avatar.y = target.y;
      }
      this.paintTag(avatar, id === leader);
    });
    if (event) this.react(event);
    this.tweens.timeScale = state.session.paused ? 0 : 1;
  }

  update() {
    for (const avatar of this.avatars.values()) this.syncTag(avatar);
    for (const avatar of this.leaving) this.syncTag(avatar);
  }

  private syncTag(avatar: Avatar) {
    avatar.tag.setPosition(avatar.root.x, avatar.root.y + avatar.sprite.y).setDepth(5000 + avatar.root.y);
    avatar.bubble?.setPosition(avatar.root.x, avatar.root.y + avatar.sprite.y - FACE_Y - FACE / 2 - 12).setDepth(6000 + avatar.root.y);
  }

  private walk(avatar: Avatar, x: number, y: number, duration = 700) {
    this.tweens.killTweensOf(avatar.root);
    this.tweens.add({ targets: avatar.root, x, y, duration, ease: 'Sine.easeInOut', onUpdate: () => avatar.root.setDepth(10 + avatar.root.y) });
    this.tweens.add({ targets: avatar.sprite, angle: { from: -4, to: 4 }, duration: 130, yoyo: true, repeat: Math.max(1, Math.floor(duration / 260)), onComplete: () => avatar.sprite.setAngle(0) });
  }

  private leave(avatar: Avatar) {
    avatar.bubble?.destroy();
    avatar.bubble = undefined;
    this.leaving.add(avatar);
    avatar.root.disableInteractive();
    this.tweens.killTweensOf(avatar.root);
    this.tweens.add({ targets: avatar.root, x: DOOR.x, y: DOOR.y, duration: 1300, ease: 'Sine.easeIn', onUpdate: () => avatar.root.setDepth(10 + avatar.root.y), onComplete: () => { this.leaving.delete(avatar); this.tweens.killTweensOf(avatar.sprite); avatar.root.destroy(); avatar.tag.destroy(); } });
    this.tweens.add({ targets: avatar.tag, alpha: 0, duration: 900 });
  }

  private jump(avatar: Avatar, height = 34) {
    if (!avatar.root.active || this.tweens.isTweening(avatar.root)) return;
    this.tweens.add({ targets: avatar.root, y: avatar.root.y - height, duration: 170, yoyo: true, repeat: 1, ease: 'Quad.easeOut' });
  }

  private bubble(avatar: Avatar, text: string, tone: 'chat' | 'alert' = 'chat') {
    avatar.bubble?.destroy();
    avatar.bubbleTimer?.remove();
    const label = this.add.text(0, 0, [...text].slice(0, 40).join(''), { fontFamily: FONT, fontSize: '19px', fontStyle: '600', color: tone === 'alert' ? '#8a2b19' : '#3e2412', align: 'center', wordWrap: { width: 250, useAdvancedWrap: true }, resolution: 2 }).setOrigin(0.5, 1);
    const width = Math.ceil(label.width + 26);
    const height = Math.ceil(label.height + 16);
    const box = this.add.graphics();
    box.fillStyle(tone === 'alert' ? 0xffe7a6 : 0xfff8ea, 0.97).fillRoundedRect(-width / 2, -height, width, height, 14).fillTriangle(-9, -1, 9, -1, 0, 11);
    box.lineStyle(2, 0xd59a45, 1).strokeRoundedRect(-width / 2, -height, width, height, 14);
    label.setY(-8);
    avatar.bubble = this.add.container(avatar.root.x, avatar.root.y, [box, label]).setScale(0.6).setAlpha(0);
    this.syncTag(avatar);
    this.tweens.add({ targets: avatar.bubble, scale: 1, alpha: 1, duration: 220, ease: 'Back.easeOut' });
    const bubble = avatar.bubble;
    avatar.bubbleTimer = this.time.delayedCall(4800, () => {
      this.tweens.add({ targets: bubble, alpha: 0, duration: 350, onComplete: () => { bubble.destroy(); if (avatar.bubble === bubble) avatar.bubble = undefined; } });
    });
  }

  private floatText(x: number, y: number, text: string, color = '#3f7d4f', size = 30) {
    const label = this.add.text(x, y, text, { fontFamily: FONT, fontSize: `${size}px`, fontStyle: '700', color, stroke: '#fff8ea', strokeThickness: 7, resolution: 2 }).setOrigin(0.5).setDepth(7000);
    this.tweens.add({ targets: label, y: y - 90, alpha: 0, delay: 900, duration: 900, onComplete: () => label.destroy() });
  }

  private sprite(key: string, x: number, y: number) {
    if (this.fx >= MAX_FX) return undefined;
    this.fx++;
    return this.add.image(x, y, key).setDepth(6500).once('destroy', () => { this.fx--; });
  }

  private hearts(x: number, y: number, count: number) {
    for (let index = 0; index < count; index++) {
      const heart = this.sprite('heart', x + (Math.random() - 0.5) * 50, y);
      if (!heart) return;
      heart.setScale(0.5 + Math.random() * 0.5).setAlpha(0.95);
      this.tweens.add({ targets: heart, y: y - 180 - Math.random() * 120, x: `+=${(Math.random() - 0.5) * 120}`, scale: heart.scale * 1.3, alpha: 0, angle: (Math.random() - 0.5) * 40, delay: index * 90, duration: 1500 + Math.random() * 600, onComplete: () => heart.destroy() });
    }
  }

  private burst(x: number, y: number, key: 'coin' | 'spark', count: number, radius = 140) {
    for (let index = 0; index < count; index++) {
      const piece = this.sprite(key, x, y);
      if (!piece) return;
      const angle = (index / count) * Math.PI * 2 + Math.random() * 0.4;
      const distance = radius * (0.6 + Math.random() * 0.5);
      piece.setScale(key === 'coin' ? 0.7 : 1.1);
      this.tweens.add({ targets: piece, x: x + Math.cos(angle) * distance, y: y + Math.sin(angle) * distance + (key === 'coin' ? 60 : 0), alpha: 0, scale: key === 'coin' ? 0.5 : 0.3, duration: 900 + Math.random() * 400, ease: 'Cubic.easeOut', onComplete: () => piece.destroy() });
    }
  }

  private confetti(count: number) {
    const colors = [0xd8452f, 0xf2c14e, 0x8b83b6, 0x7fa37a, 0xf08aa0];
    for (let index = 0; index < count; index++) {
      if (this.fx >= MAX_FX) return;
      this.fx++;
      const piece = this.add.rectangle(60 + Math.random() * 960, 220 - Math.random() * 120, 12, 22, colors[index % colors.length]).setAngle(index * 23).setDepth(6600).once('destroy', () => { this.fx--; });
      this.tweens.add({ targets: piece, y: 1450 + Math.random() * 200, x: `+=${(Math.random() - 0.5) * 200}`, angle: `+=${200 + index * 9}`, alpha: 0, duration: 2600 + Math.random() * 1400, delay: index * 22, onComplete: () => piece.destroy() });
    }
  }

  private fireworks(times: number) {
    for (let index = 0; index < times; index++) {
      this.time.delayedCall(index * 420, () => this.burst(220 + Math.random() * 640, 560 + Math.random() * 380, 'spark', 18, 170));
    }
  }

  private avatarFor(event: GameResult) {
    return event.player ? this.avatars.get(event.player.id) : undefined;
  }

  react(event: GameResult) {
    if (!this.ready || !event.ok || event.duplicate) return;
    const avatar = this.avatarFor(event);
    const head = avatar ? { x: avatar.root.x, y: avatar.root.y - FACE_Y } : HEARTS_SPOT;
    switch (event.code) {
      case 'WORKED':
        if (!avatar) break;
        this.tweens.add({ targets: avatar.sprite, scaleX: avatar.sprite.scaleX * 1.06, scaleY: avatar.sprite.scaleY * 0.96, duration: 140, yoyo: true, repeat: 3 });
        this.floatText(head.x, head.y - 40, '+10 KPI', '#2f7a46');
        if (event.mission_completed) { this.time.delayedCall(450, () => this.floatText(head.x, head.y - 80, 'Xong 3 việc · +500 xu', '#b07a12', 30)); this.burst(head.x, head.y, 'coin', 10); }
        break;
      case 'PROFILE':
        if (avatar && event.player) this.floatText(head.x, head.y - 40, `${event.player.coins.toLocaleString('vi-VN')} xu`, '#b07a12');
        break;
      case 'COFFEE':
        if (!avatar) break;
        avatar.away = true;
        this.walk(avatar, COFFEE.x + (avatar.x < COFFEE.x ? -95 : 95), COFFEE.y + 62, 1000);
        this.time.delayedCall(1150, () => { if (avatar.root.active) this.bubble(avatar, 'Nạp chút năng lượng!'); });
        this.time.delayedCall(4800, () => { if (!avatar.root.active) return; avatar.away = false; this.walk(avatar, avatar.x, avatar.y, 1000); });
        break;
      case 'CHAT':
        if (avatar && event.text) this.bubble(avatar, event.text);
        break;
      case 'COOLDOWN':
        if (avatar && event.remaining) this.bubble(avatar, `Đợi ${event.remaining} giây nữa nha`, 'alert');
        break;
      case 'LIKED':
        this.hearts(head.x, head.y, Math.min(6, 1 + Math.floor((event.count ?? 1) / 6)));
        break;
      case 'BOOST':
        this.hearts(head.x, head.y, 6);
        this.cameras.main.flash(500, 255, 170, 190, false);
        this.floatText(540, 980, 'TIẾP SỨC!', '#d8345a', 54);
        this.hearts(540, 1000, 6);
        for (const current of this.avatars.values()) this.jump(current, 22);
        break;
      case 'FOLLOWED':
        this.hearts(head.x, head.y, 6);
        if (avatar) { this.jump(avatar); this.floatText(head.x, head.y - 50, 'Ký hợp đồng!', '#b0331f', 30); }
        break;
      case 'SHARED':
        this.burst(head.x, head.y, 'spark', 12, 110);
        if (avatar) this.floatText(head.x, head.y - 50, '+300 xu', '#b07a12');
        break;
      case 'GIFTED': {
        const tier = event.gift?.tier ?? 'lixi';
        this.burst(head.x, head.y, 'coin', tier === 'lixi' ? 8 : 14, 160);
        if (avatar) this.jump(avatar);
        if (tier !== 'lixi') this.confetti(tier === 'party' ? 70 : 34);
        if (tier === 'party') { this.fireworks(4); this.cameras.main.flash(450, 255, 225, 150, false); for (const current of this.avatars.values()) this.jump(current, 26); }
        break;
      }
    }
    if (event.action === 'boss') {
      this.cameras.main.flash(450, 255, 224, 150, false);
      this.cameras.main.shake(380, 0.004);
      for (const current of this.avatars.values()) { if (current.away) { current.away = false; this.walk(current, current.x, current.y, 450); } this.bubble(current, 'Dạ sếp!', 'alert'); }
    }
    if (event.action === 'bonus' || event.action === 'next_month') {
      this.confetti(event.action === 'bonus' ? 80 : 46);
      if (event.action === 'bonus') this.fireworks(5);
    }
  }
}

export function createOffice(parent: HTMLElement, onSelect: (player: Player) => void, forceCanvas = false) {
  const office = new OfficeScene();
  const station = new StationScene();
  office.onSelect = onSelect;
  let current: 'office' | 'station' = 'office';
  let stationLaunched = false;

  const sync = () => {
    const inStation = current === 'station';
    if (office.sys?.settings) {
      office.scene.setVisible(!inStation);
      office.scene.setActive(!inStation);
      if (office.input) office.input.enabled = !inStation;
    }
    if (stationLaunched && station.sys?.settings) {
      station.scene.setVisible(inStation);
      station.scene.setActive(inStation);
    }
  };

  office.onCreated = () => {
    office.scene.launch('station');
    stationLaunched = true;
    station.events.once('create', () => sync());
    sync();
  };

  const game = new Phaser.Game({
    type: forceCanvas ? Phaser.CANVAS : Phaser.AUTO,
    parent,
    width: STAGE_W,
    height: STAGE_H,
    backgroundColor: '#c98a55',
    scene: [office, station],
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    render: { antialias: true, roundPixels: true },
    fps: { target: 30, forceSetTimeOut: true },
    audio: { noAudio: true },
  });

  const applyCanvasSmoothing = () => {
    const renderer = game.renderer;
    if (renderer && 'gameContext' in renderer && renderer.gameContext) {
      renderer.gameContext.imageSmoothingEnabled = true;
      renderer.gameContext.imageSmoothingQuality = 'high';
    }
  };
  game.events.once(Phaser.Core.Events.READY, () => {
    applyCanvasSmoothing();
    game.renderer?.on?.(Phaser.Renderer.Events.PRE_RENDER, applyCanvasSmoothing);
  });

  const scene = {
    applyState(state: GameState) {
      current = state.session.scene === 'station' ? 'station' : 'office';
      sync();
      if (current === 'station') station.applyState(state);
      else office.applyState(state);
    },
    react(event: GameResult) {
      if (current === 'station') station.react(event);
      else office.react(event);
    },
  };

  return { game, scene };
}
