import Phaser from 'phaser';
import { FONT, ensureScaledTexture, facesFor, makeCanvas, shortName, waitForFonts, type Faces } from './faces';
import { Effects, ensureFxTextures } from './fx';
import type { GameResult, GameState, SeatOccupant, StationRoute, WaitingViewer } from './types';

const W = 1080;
const H = 1920;
const BUS_X = 540;
const BUS_Y = 880;          // top of the bus body
const BUS_W = 536;
const BUS_H = 594;
const SEAT_W = 92;
const SEAT_H = 74;
const FACE_SIZE = 36;
const SEAT_X = [-192, -92, 92, 192];
const ROW_Y = (row: number) => 102 + row * 82;
const DOOR = { x: BUS_X + BUS_W / 2 + 6, y: BUS_Y + 104 };
const ARRIVE_FROM = H + 260;
const SIDE_SPOT = { x: 890, y: 1220 };
const WAIT_FIGURE = 90;
const WAIT_FACE = 36;
const WAIT_NAME_Y = 100;
const WAIT_FACE_Y = 134;
const WAIT_SKIN_TINT = [0xffffff, 0xffffff, 0xffe9d3, 0xe7e6ff];
const WAIT_ENTRANCE = { x: 938, y: 1640 };
const WAIT_SLOTS = [
  { x: 856, y: 1148 },
  { x: 922, y: 1218 },
  { x: 856, y: 1288 },
  { x: 922, y: 1358 },
  { x: 856, y: 1428 },
  { x: 922, y: 1498 },
  { x: 176, y: 1148 },
  { x: 212, y: 1298 },
];

type WaiterView = {
  id: string;
  viewer: WaitingViewer;
  root: Phaser.GameObjects.Container;
  sprite: Phaser.GameObjects.Image;
  tag: Phaser.GameObjects.Container;
  face: Phaser.GameObjects.Image;
  pill: Phaser.GameObjects.Graphics;
  ring: Phaser.GameObjects.Graphics;
  label: Phaser.GameObjects.Text;
  bubble?: Phaser.GameObjects.Container;
  bubbleTimer?: Phaser.Time.TimerEvent;
  x: number;
  y: number;
};

type SeatView = {
  seatNumber: number;
  root: Phaser.GameObjects.Container;
  box: Phaser.GameObjects.Graphics;
  number: Phaser.GameObjects.Text;
  badge: Phaser.GameObjects.Text;
  face: Phaser.GameObjects.Image;
  name: Phaser.GameObjects.Text;
  hometown: Phaser.GameObjects.Text;
  occupant: SeatOccupant | null;
  x: number;
  y: number;
};

const seatPosition = (index: number) => ({ x: SEAT_X[index % 4], y: ROW_Y(Math.floor(index / 4)) });
const hex = (color: string) => Phaser.Display.Color.HexStringToColor(color).color;

export class StationScene extends Phaser.Scene {
  private ready = false;
  private pending?: GameState;
  private faces!: Faces;
  private fx!: Effects;
  private bus?: Phaser.GameObjects.Container;
  private body?: Phaser.GameObjects.Graphics;
  private wheelMarks?: Phaser.GameObjects.Graphics;
  private idleTween?: Phaser.Tweens.Tween;
  private wheelTween?: Phaser.Tweens.Tween;
  private banner?: Phaser.GameObjects.Text;
  private seats: SeatView[] = [];
  private shownBus: { route: string; id: number | null; number: number } | null = null;
  private countdown?: Phaser.GameObjects.Text;
  private led?: { title: Phaser.GameObjects.Text; stops: Phaser.GameObjects.Text; info: Phaser.GameObjects.Text };
  private ledSlice = -1;
  private route?: StationRoute;
  private clockOffset = 0;
  private departing = false;
  private queued?: StationRoute;
  private bubbles = new Map<number, Phaser.GameObjects.Container>();
  private waiters = new Map<string, WaiterView>();
  private leavingWaiters = new Set<WaiterView>();
  private boardingIds = new Set<string>();
  private queueReady = false;
  private queueHeader?: { badge: Phaser.GameObjects.Text; count: Phaser.GameObjects.Text; more: Phaser.GameObjects.Text };
  private releaseFaces?: () => void;
  private releaseReady?: () => void;

  constructor() { super('station'); }

  create() {
    this.faces = facesFor(this.game);
    this.fx = new Effects(this);
    ensureFxTextures(this.textures);
    ensureScaledTexture(this.textures, 'boy', 'boy_wait', WAIT_FIGURE * 2);
    ensureScaledTexture(this.textures, 'girl', 'girl_wait', WAIT_FIGURE * 2);
    ensureScaledTexture(this.textures, 'boy', 'boy_walk', 240);
    ensureScaledTexture(this.textures, 'girl', 'girl_walk', 240);
    this.releaseFaces = this.faces.use(() => [
      ...this.seats.map(seat => seat.occupant?.avatar ?? ''),
      ...Array.from(this.waiters.values(), waiter => waiter.viewer.avatar ?? ''),
    ].filter(Boolean));
    this.releaseReady = this.faces.onReady((url, key) => {
      for (const seat of this.seats) if (seat.occupant?.avatar === url) seat.face.setTexture(key).setDisplaySize(FACE_SIZE, FACE_SIZE);
      for (const waiter of this.waiters.values()) if (waiter.viewer.avatar === url) waiter.face.setTexture(key).setDisplaySize(WAIT_FACE, WAIT_FACE);
    });
    this.events.once('shutdown', () => { this.ready = false; this.releaseFaces?.(); this.releaseReady?.(); });
    for (let index = 0; index < 7; index++) {
      const glow = this.add.image(80 + index * 153, 100 + (index % 2) * 30, 'spark').setDepth(1).setDisplaySize(90, 90).setAlpha(0.24);
      this.tweens.add({ targets: glow, alpha: 0.5, scale: glow.scale * 1.15, duration: 1500 + index * 180, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    }
    for (let index = 0; index < 8; index++) {
      const petal = this.add.image(80 + index * 130, 200 + (index % 3) * 50, 'petal').setDepth(4000).setAlpha(0.7);
      this.tweens.add({ targets: petal, y: 1500, x: `+=${60 - index * 15}`, angle: 280, alpha: 0, duration: 12500 + index * 1300, delay: index * 1000, repeat: -1, onRepeat: () => { petal.y = 200; petal.alpha = 0.7; } });
    }
    this.time.addEvent({
      delay: 1100,
      loop: true,
      callback: () => {
        if (this.bus?.active && !this.departing && !this.pending?.session.paused) {
          this.fx.burst(this.bus.x - 140, this.bus.y + BUS_H + 4, 'puff', 1, 18);
        }
      },
    });
    void waitForFonts().finally(() => {
      if (!this.sys?.settings || !(this.scene as { manager?: unknown } | undefined)?.manager) return;
      if (!this.textures.exists('station-bg')) this.buildBackground();
      this.add.image(0, 0, 'station-bg').setOrigin(0, 0).setDepth(0);
      this.buildLed();
      this.buildQueueSign();
      this.ready = true;
      if (this.pending) this.applyState(this.pending);
    });
  }

  /** The station hall, platform and asphalt are painted once into one texture. */
  private buildBackground() {
    const canvas = makeCanvas(W, H);
    const g = canvas.getContext('2d')!;
    const sky = g.createLinearGradient(0, 0, 0, 520);
    sky.addColorStop(0, '#f2a97f'); sky.addColorStop(1, '#fbe3c5');
    g.fillStyle = sky; g.fillRect(0, 0, W, 520);
    // Hall facade with clean symmetric arches and a centered boarding gate.
    g.fillStyle = '#f4e4c8'; g.fillRect(0, 150, W, 720);
    g.fillStyle = '#b8352a'; g.fillRect(0, 140, W, 26);
    g.fillStyle = '#e8b55a'; g.fillRect(0, 166, W, 8);
    for (let index = 0; index < 5; index++) {
      const x = 35 + index * 210;
      g.fillStyle = '#e6d0aa';
      g.beginPath(); g.moveTo(x, 860); g.lineTo(x, 330); g.arc(x + 85, 330, 85, Math.PI, 0); g.lineTo(x + 170, 860); g.closePath(); g.fill();
      g.fillStyle = '#9fc3c9';
      g.beginPath(); g.moveTo(x + 18, 600); g.lineTo(x + 18, 340); g.arc(x + 85, 340, 67, Math.PI, 0); g.lineTo(x + 152, 600); g.closePath(); g.fill();
      g.strokeStyle = '#f7efe0'; g.lineWidth = 6;
      g.beginPath(); g.moveTo(x + 85, 274); g.lineTo(x + 85, 600); g.moveTo(x + 18, 450); g.lineTo(x + 152, 450); g.stroke();
      // Keep side arches free of text signs so HUD cards never half-occlude "QUẦY VÉ".
      g.fillStyle = '#8a5a3a'; g.fillRect(x + 10, 640, 150, 160);
      g.strokeStyle = '#c8a87e'; g.lineWidth = 3; g.strokeRect(x + 20, 650, 130, 140);
      if (index === 2) {
        g.fillStyle = '#f2c45f';
        g.beginPath(); g.roundRect(x + 12, 654, 146, 34, 8); g.fill();
        g.strokeStyle = '#5c1b10'; g.lineWidth = 2; g.stroke();
        g.fillStyle = '#5c1b10'; g.font = `700 18px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('CỔNG RA XE', x + 85, 672);
      }
    }
    // Lanterns and garland across the top.
    for (let index = 0; index < 7; index++) {
      const x = 80 + index * 153;
      g.strokeStyle = '#7a3a1a'; g.lineWidth = 3; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 60 + (index % 2) * 30); g.stroke();
      const y = 100 + (index % 2) * 30;
      const lantern = g.createRadialGradient(x - 10, y - 12, 4, x, y, 42);
      lantern.addColorStop(0, '#ff8a5c'); lantern.addColorStop(1, '#c4271b');
      g.fillStyle = lantern; g.beginPath(); g.ellipse(x, y, 34, 40, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#f2c45f'; g.fillRect(x - 16, y - 46, 32, 8); g.fillRect(x - 16, y + 38, 32, 8);
      g.strokeStyle = '#f2c45f'; g.lineWidth = 3; g.beginPath(); g.moveTo(x, y + 46); g.lineTo(x, y + 76); g.stroke();
    }
    // Platform with a tactile strip.
    g.fillStyle = '#cfc6b8'; g.fillRect(0, 860, W, 70);
    g.fillStyle = '#f2c94c'; g.fillRect(0, 906, W, 12);
    g.fillStyle = '#a89e90'; g.fillRect(0, 926, W, 8);
    // Asphalt bay.
    const road = g.createLinearGradient(0, 934, 0, H);
    road.addColorStop(0, '#5a5a62'); road.addColorStop(1, '#3a3a40');
    g.fillStyle = road; g.fillRect(0, 934, W, H - 934);
    g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 6; g.setLineDash([36, 26]);
    for (const x of [240, 840]) { g.beginPath(); g.moveTo(x, 960); g.lineTo(x, H); g.stroke(); }
    g.setLineDash([]);
    g.fillStyle = 'rgba(246,212,98,.9)';
    g.font = `700 44px ${FONT}`; g.textAlign = 'center';
    g.fillText('BẾN 1', BUS_X, 1640);
    // Waiting benches on the left side of the bay.
    for (let row = 0; row < 3; row++) {
      const x = 138;
      const y = 1040 + row * 150;
      g.fillStyle = '#8a5a3a'; g.fillRect(x - 42, y, 84, 18); g.fillRect(x - 36, y + 18, 10, 26); g.fillRect(x + 26, y + 18, 10, 26);
      g.fillStyle = ['#d8452f', '#3f7d9e', '#e0a43a'][row]; g.fillRect(x - 18, y - 46, 36, 46);
      g.fillStyle = '#2b2522'; g.fillRect(x - 8, y - 56, 16, 10);
    }
    // Dedicated Boarding Queue lane right outside the bus door (x = 818..968).
    g.fillStyle = 'rgba(24, 18, 15, 0.58)';
    g.beginPath(); g.roundRect(818, 946, 150, 588, 18); g.fill();
    g.strokeStyle = 'rgba(242, 196, 95, 0.85)'; g.lineWidth = 3; g.setLineDash([10, 8]);
    g.beginPath(); g.roundRect(818, 946, 150, 588, 18); g.stroke();
    g.setLineDash([]);
    // Velvet rope stanchions guiding toward the bus door.
    g.strokeStyle = '#c83a2b'; g.lineWidth = 5;
    g.beginPath(); g.moveTo(960, 990); g.lineTo(960, 1510); g.stroke();
    for (const py of [990, 1163, 1336, 1510]) {
      g.fillStyle = '#f2c45f'; g.beginPath(); g.arc(960, py, 7, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = '#ffd977';
    g.font = `700 18px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('⬅ LÊN XE', 893, 968);
    const bottom = g.createLinearGradient(0, 1420, 0, H);
    bottom.addColorStop(0, 'rgba(20,10,6,0)'); bottom.addColorStop(1, 'rgba(20,10,6,.6)');
    g.fillStyle = bottom; g.fillRect(0, 1420, W, H - 1420);
    this.textures.addCanvas('station-bg', canvas);
  }

  private buildLed() {
    const g = this.add.graphics().setDepth(5);
    g.fillStyle(0x1e1a1a, 0.96).fillRoundedRect(406, 440, 268, 170, 18);
    g.lineStyle(4, 0xf2c45f).strokeRoundedRect(406, 440, 268, 170, 18);
    const style = { fontFamily: FONT, fontStyle: '700', color: '#ffc861', align: 'center', resolution: 2 } as const;
    this.led = {
      title: this.add.text(540, 468, 'CỔNG RA XE', { ...style, fontSize: '26px' }).setOrigin(0.5).setDepth(6),
      stops: this.add.text(540, 524, '', { ...style, fontSize: '17px', color: '#ffe6a8', lineSpacing: 4, wordWrap: { width: 244 } }).setOrigin(0.5).setDepth(6),
      info: this.add.text(540, 584, '', { ...style, fontSize: '19px', color: '#8fe3b0' }).setOrigin(0.5).setDepth(6),
    };
    this.countdown = this.add.text(BUS_X, 852, '', { fontFamily: FONT, fontSize: '21px', fontStyle: '700', color: '#ffffff', backgroundColor: '#c4271bee', padding: { x: 14, y: 6 }, resolution: 2 }).setOrigin(0.5).setDepth(5200).setVisible(false);
  }

  private buildQueueSign() {
    this.queueHeader = {
      badge: this.add.text(893, 886, 'HÀNG CHỜ LÊN XE', {
        fontFamily: FONT, fontSize: '16px', fontStyle: '700', color: '#fff3d1',
        backgroundColor: '#7a2113f2', padding: { x: 10, y: 4 }, resolution: 2,
      }).setOrigin(0.5).setDepth(8),
      count: this.add.text(893, 916, 'Chưa có khách chờ', {
        fontFamily: FONT, fontSize: '13.5px', fontStyle: '700', color: '#ffe19a',
        backgroundColor: '#2c1f1af0', padding: { x: 8, y: 3 }, resolution: 2,
      }).setOrigin(0.5).setDepth(8),
      more: this.add.text(893, 1558, '', {
        fontFamily: FONT, fontSize: '14px', fontStyle: '700', color: '#fff3d1',
        backgroundColor: '#8a3220f2', padding: { x: 10, y: 4 }, resolution: 2,
      }).setOrigin(0.5).setDepth(9).setVisible(false),
    };
  }

  private startIdle() {
    this.idleTween?.stop();
    if (!this.bus || this.departing) return;
    this.bus.y = BUS_Y;
    this.idleTween = this.tweens.add({ targets: this.bus, y: BUS_Y - 2, duration: 520, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
  }

  private setWheelsSpinning(spinning: boolean) {
    this.wheelTween?.stop();
    this.wheelTween = undefined;
    if (this.wheelMarks) this.wheelMarks.y = 0;
    if (spinning && this.wheelMarks) {
      this.wheelTween = this.tweens.add({ targets: this.wheelMarks, y: { from: -5, to: 5 }, duration: 95, repeat: -1 });
    }
  }

  private buildBus(route: StationRoute) {
    this.idleTween?.stop();
    this.idleTween = undefined;
    this.setWheelsSpinning(false);
    this.bus?.destroy();
    for (const bubble of this.bubbles.values()) bubble.destroy();
    this.bubbles.clear();
    const color = hex(route.color);
    const body = this.add.graphics();
    body.fillStyle(0x000000, 0.28).fillRoundedRect(-BUS_W / 2 + 14, 18, BUS_W, BUS_H, 48);
    // Four protruding tires on the left and right wheel arches.
    for (const wx of [-BUS_W / 2 - 8, BUS_W / 2 - 6]) {
      for (const wy of [104, BUS_H - 154]) {
        body.fillStyle(0x221f1e).fillRoundedRect(wx, wy, 14, 58, 5);
      }
    }
    body.fillStyle(color).fillRoundedRect(-BUS_W / 2, 0, BUS_W, BUS_H, 48);
    body.fillStyle(0xffffff, 0.16).fillRoundedRect(-BUS_W / 2 + 8, 6, BUS_W - 16, 18, 9);
    body.fillStyle(0xf3ece0).fillRoundedRect(-BUS_W / 2 + 20, 60, BUS_W - 40, BUS_H - 94, 22);
    body.fillStyle(0x23384f).fillRoundedRect(-BUS_W / 2 + 28, 12, BUS_W - 56, 40, 16);
    body.fillStyle(0x9fd0e8, 0.55).fillRoundedRect(-BUS_W / 2 + 44, 18, 120, 10, 5);
    body.fillStyle(0x2b2522).fillRect(-BUS_W / 2 - 12, 26, 14, 30).fillRect(BUS_W / 2 - 2, 26, 14, 30);
    body.fillStyle(0xfff4cc, 0.25).fillTriangle(-BUS_W / 2 + 40, 4, -BUS_W / 2 + 16, -44, -BUS_W / 2 + 64, -44).fillTriangle(BUS_W / 2 - 40, 4, BUS_W / 2 - 64, -44, BUS_W / 2 - 16, -44);
    body.fillStyle(0xfff4cc).fillCircle(-BUS_W / 2 + 40, 4, 9).fillCircle(BUS_W / 2 - 40, 4, 9);
    body.fillStyle(0xd9d2c4).fillRect(BUS_W / 2 - 24, 72, 24, 70);
    body.fillStyle(0x2b2522, 0.85).fillRoundedRect(-BUS_W / 2 + 40, BUS_H - 30, BUS_W - 80, 16, 8);
    body.fillStyle(0xe0d8ca).fillRect(-38, 60, 76, BUS_H - 94);
    const wheelMarks = this.add.graphics();
    wheelMarks.fillStyle(0x6c6560, 0.9);
    for (const wx of [-BUS_W / 2 - 6, BUS_W / 2 - 4]) {
      for (const wy of [104, BUS_H - 154]) {
        for (const dy of [12, 26, 40]) wheelMarks.fillRect(wx, wy + dy, 10, 5);
      }
    }
    this.body = body;
    this.wheelMarks = wheelMarks;
    this.banner = this.add.text(0, 32, '', { fontFamily: FONT, fontSize: '22px', fontStyle: '700', color: '#ffffff', stroke: '#162636', strokeThickness: 3, resolution: 2 }).setOrigin(0.5);
    const container = this.add.container(BUS_X, BUS_Y, [wheelMarks, body, this.banner]).setDepth(20);
    this.seats = [];
    for (let index = 0; index < 24; index++) {
      const { x, y } = seatPosition(index);
      const box = this.add.graphics();
      const number = this.add.text(0, 0, String(index + 1), { fontFamily: FONT, fontSize: '30px', fontStyle: '700', color: '#1d5a4e', resolution: 2 }).setOrigin(0.5);
      const badge = this.add.text(-SEAT_W / 2 + 6, -SEAT_H / 2 + 4, String(index + 1), { fontFamily: FONT, fontSize: '12px', fontStyle: '700', color: '#6a2d12', stroke: '#fff7ea', strokeThickness: 2, resolution: 2 }).setOrigin(0, 0).setVisible(false);
      const face = this.add.image(0, -13, '__DEFAULT').setDisplaySize(FACE_SIZE, FACE_SIZE).setVisible(false);
      const name = this.add.text(0, 14, '', { fontFamily: FONT, fontSize: '13.5px', fontStyle: '700', color: '#3f1607', stroke: '#fff6e8', strokeThickness: 2, resolution: 2 }).setOrigin(0.5);
      const hometown = this.add.text(0, 29, '', { fontFamily: FONT, fontSize: '11.5px', fontStyle: '700', color: '#521506', resolution: 2 }).setOrigin(0.5).setVisible(false);
      const root = this.add.container(x, y, [box, number, badge, face, name, hometown]);
      container.add(root);
      const seat: SeatView = { seatNumber: index + 1, root, box, number, badge, face, name, hometown, occupant: null, x, y };
      this.paintSeat(seat, null, false);
      this.seats.push(seat);
    }
    this.bus = container;
    return container;
  }

  private paintSeat(seat: SeatView, occupant: SeatOccupant | null, animate: boolean) {
    const incoming = Boolean(occupant && this.boardingIds.has(occupant.id));
    const taken = Boolean(occupant) && !incoming;
    const hasHome = taken && Boolean(occupant?.hometown);
    seat.box.clear();
    seat.box.fillStyle(taken ? 0xffe0c9 : 0xd9f1ea).fillRoundedRect(-SEAT_W / 2, -SEAT_H / 2, SEAT_W, SEAT_H, 14);
    seat.box.lineStyle(3, (animate && taken) || incoming ? 0xf2b632 : taken ? 0xe39a6c : 0x7dc2af).strokeRoundedRect(-SEAT_W / 2, -SEAT_H / 2, SEAT_W, SEAT_H, 14);
    if (hasHome) {
      seat.box.fillStyle(0xf7cf6b).fillRoundedRect(-SEAT_W / 2 + 5, SEAT_H / 2 - 15, SEAT_W - 10, 14, 5);
    } else {
      seat.box.fillStyle(taken ? 0xe7b493 : 0xb3ded2).fillRoundedRect(-SEAT_W / 2 + 8, SEAT_H / 2 - 10, SEAT_W - 16, 6, 3);
    }
    seat.number.setVisible(!taken);
    seat.badge.setVisible(taken);
    seat.face.setVisible(taken);
    seat.name.setY(hasHome ? 13 : 20).setText(taken && occupant ? shortName(occupant.nickname, 8) : '');
    seat.hometown.setVisible(hasHome).setText(hasHome ? shortName(occupant!.hometown!, 10) : '');
    if (taken && occupant) seat.face.setTexture(this.faces.key(occupant)).setDisplaySize(FACE_SIZE, FACE_SIZE);
    seat.occupant = occupant;
    if (animate && taken) {
      seat.root.setScale(0.6);
      this.tweens.add({ targets: seat.root, scale: 1, duration: 340, ease: 'Back.easeOut', onComplete: () => this.paintSeat(seat, seat.occupant, false) });
    }
  }

  private seatWorld(index: number) {
    const seat = this.seats[index];
    return { x: (this.bus?.x ?? BUS_X) + seat.x, y: (this.bus?.y ?? BUS_Y) + seat.y };
  }

  private seatOf(playerId?: string) {
    if (!playerId) return -1;
    return this.seats.findIndex(seat => seat.occupant?.id === playerId);
  }

  private focusRoute(state: GameState) {
    return state.station.routes.find(route => route.code === state.station.focus) ?? state.station.routes[0];
  }

  applyState(state: GameState) {
    this.pending = state;
    if (!this.ready || !state.station) return;
    this.clockOffset = state.server_time - Date.now() / 1000;
    const route = this.focusRoute(state);
    this.route = route;
    this.tweens.timeScale = state.session.paused ? 0 : 1;
    const waiting = state.station.waiting ?? [];
    if (this.departing) {
      this.queued = route;
      this.syncWaiting(waiting, new Map());
      return;
    }
    const seatedById = new Map<string, { index: number; occupant: SeatOccupant }>();
    route.bus.seats.forEach((occupant, index) => {
      if (occupant) seatedById.set(occupant.id, { index, occupant });
    });
    const sameShownBus = Boolean(this.bus && this.shownBus && this.shownBus.route === route.code && route.bus.number === this.shownBus.number);
    this.syncWaiting(waiting, sameShownBus ? seatedById : new Map());
    if (!this.bus || !this.shownBus) this.showBus(route, false);
    else if (this.shownBus.route !== route.code) this.showBus(route, true);
    else if (route.bus.number > this.shownBus.number) {
      // State arrives before its DEPARTED event: a higher bus number on the same route means the shown bus left.
      this.queued = route;
      this.depart(this.seats.filter(seat => seat.occupant).length);
      return;
    } else {
      this.shownBus = { route: route.code, id: route.bus.id, number: route.bus.number };
      route.bus.seats.forEach((occupant, index) => {
        const seat = this.seats[index];
        const before = seat.occupant;
        if ((before?.id ?? null) !== (occupant?.id ?? null) || before?.avatar !== occupant?.avatar || before?.nickname !== occupant?.nickname || before?.hometown !== occupant?.hometown) {
          if (before && !occupant) this.fx.burst(this.seatWorld(index).x, this.seatWorld(index).y, 'puff', 6, 50);
          this.paintSeat(seat, occupant, Boolean(occupant) && before?.id !== occupant?.id);
        }
      });
    }
    this.paintInfo(route);
  }

  private showBus(route: StationRoute, sideways: boolean) {
    this.boardingIds.clear();
    const bus = this.buildBus(route);
    this.shownBus = { route: route.code, id: route.bus.id, number: route.bus.number };
    route.bus.seats.forEach((occupant, index) => this.paintSeat(this.seats[index], occupant, false));
    this.setWheelsSpinning(true);
    const finishArrival = () => {
      if (this.bus === bus && !this.departing) {
        this.setWheelsSpinning(false);
        this.startIdle();
      }
    };
    if (sideways) {
      bus.setX(BUS_X + 900);
      this.tweens.add({ targets: bus, x: BUS_X, duration: 650, ease: 'Cubic.easeOut', onComplete: finishArrival });
    } else {
      bus.setY(ARRIVE_FROM);
      this.tweens.add({ targets: bus, y: BUS_Y, duration: 1100, ease: 'Cubic.easeOut', onComplete: finishArrival });
    }
  }

  private paintWaiterTag(waiter: WaiterView) {
    const { viewer, label, pill, ring } = waiter;
    label.setText(shortName(viewer.nickname, 8));
    const width = Math.max(58, Math.ceil(label.width + 20));
    const demo = viewer.id.startsWith('demo_');
    pill.clear();
    pill.fillStyle(demo ? 0x4a3a32 : 0x5c1b10, 0.94).fillRoundedRect(-width / 2, -WAIT_NAME_Y - 14, width, 28, 14);
    pill.lineStyle(2, 0xf6cf6b, 0.95).strokeRoundedRect(-width / 2, -WAIT_NAME_Y - 14, width, 28, 14);
    label.setPosition(0, -WAIT_NAME_Y);
    ring.clear();
    ring.lineStyle(3, 0xfff3dc, 1).strokeCircle(0, -WAIT_FACE_Y, WAIT_FACE / 2 + 1);
  }

  private createWaiter(viewer: WaitingViewer, targetX: number, targetY: number, animateEnter: boolean, bubbleText?: string): WaiterView {
    const spawn = animateEnter ? WAIT_ENTRANCE : { x: targetX, y: targetY };
    const shadow = this.add.ellipse(0, 2, 48, 12, 0x2a1810, 0.3);
    const sprite = this.add.image(0, 0, viewer.skin % 2 ? 'girl_wait' : 'boy_wait')
      .setOrigin(0.5, 1)
      .setDisplaySize(WAIT_FIGURE, WAIT_FIGURE)
      .setTint(WAIT_SKIN_TINT[viewer.skin % 4]);
    const root = this.add.container(spawn.x, spawn.y, [shadow, sprite]).setDepth(30 + spawn.y * 0.01);
    const pill = this.add.graphics();
    const label = this.add.text(0, -WAIT_NAME_Y, '', { fontFamily: FONT, fontSize: '16px', fontStyle: '700', color: '#fff6e3', stroke: '#3a1008', strokeThickness: 2, resolution: 2 }).setOrigin(0.5, 0.5);
    const face = this.add.image(0, -WAIT_FACE_Y, this.faces.key(viewer)).setDisplaySize(WAIT_FACE, WAIT_FACE);
    const ring = this.add.graphics();
    const tag = this.add.container(spawn.x, spawn.y, [pill, label, face, ring]).setDepth(5000 + spawn.y * 0.01);
    const waiter: WaiterView = { id: viewer.id, viewer, root, sprite, tag, face, pill, ring, label, x: targetX, y: targetY };
    this.paintWaiterTag(waiter);
    this.tweens.add({ targets: sprite, y: -3, duration: 950 + Math.random() * 400, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    this.syncWaiterTag(waiter);
    if (animateEnter) {
      this.walkWaiter(waiter, targetX, targetY, 980, () => {
        if (!waiter.root.active) return;
        this.waveWaiter(waiter);
        this.fx.burst(waiter.root.x, waiter.root.y - 54, 'spark', 6, 44);
      });
      this.waiterBubble(waiter, bubbleText ?? 'Mới vào bến!');
    }
    return waiter;
  }

  private syncWaiterTag(waiter: WaiterView) {
    if (!waiter.root.active) return;
    const clampedX = Math.max(156, Math.min(W - 156, waiter.root.x));
    const y = waiter.root.y + waiter.sprite.y;
    waiter.tag.setPosition(clampedX, y).setDepth(5000 + waiter.root.y * 0.01);
    waiter.bubble?.setPosition(clampedX, y - WAIT_FACE_Y - WAIT_FACE / 2 - 10).setDepth(6000 + waiter.root.y * 0.01);
  }

  private walkWaiter(waiter: WaiterView, x: number, y: number, duration = 600, onComplete?: () => void) {
    waiter.x = x;
    waiter.y = y;
    this.tweens.killTweensOf(waiter.root);
    this.tweens.add({
      targets: waiter.root,
      x,
      y,
      duration,
      ease: 'Sine.easeInOut',
      onUpdate: () => { if (waiter.root.active) waiter.root.setDepth(30 + waiter.root.y * 0.01); },
      onComplete: () => onComplete?.(),
    });
    this.tweens.add({
      targets: waiter.sprite,
      angle: { from: -6, to: 6 },
      duration: 120,
      yoyo: true,
      repeat: Math.max(1, Math.floor(duration / 240)),
      onComplete: () => { if (waiter.sprite.active) waiter.sprite.setAngle(0); },
    });
  }

  private waveWaiter(waiter: WaiterView) {
    if (!waiter.root.active) return;
    this.tweens.add({
      targets: waiter.root,
      y: waiter.root.y - 16,
      duration: 160,
      yoyo: true,
      repeat: 1,
      ease: 'Quad.easeOut',
    });
    this.tweens.add({
      targets: waiter.sprite,
      angle: { from: -10, to: 10 },
      duration: 130,
      yoyo: true,
      repeat: 2,
      onComplete: () => { if (waiter.sprite.active) waiter.sprite.setAngle(0); },
    });
  }

  private waiterBubble(waiter: WaiterView, text: string, tone: 'chat' | 'alert' = 'chat') {
    waiter.bubble?.destroy();
    waiter.bubbleTimer?.remove();
    const label = this.add.text(0, -8, [...text].slice(0, 32).join(''), {
      fontFamily: FONT, fontSize: '16px', fontStyle: '700',
      color: tone === 'alert' ? '#8a2b19' : '#3e2412',
      align: 'center', wordWrap: { width: 200, useAdvancedWrap: true }, resolution: 2,
    }).setOrigin(0.5, 1);
    const width = Math.ceil(label.width + 22);
    const height = Math.ceil(label.height + 14);
    const box = this.add.graphics();
    box.fillStyle(tone === 'alert' ? 0xffe7a6 : 0xfff8ea, 0.97).fillRoundedRect(-width / 2, -height, width, height, 12).fillTriangle(-8, -1, 8, -1, 0, 9);
    box.lineStyle(2, 0xd59a45).strokeRoundedRect(-width / 2, -height, width, height, 12);
    const bubble = this.add.container(waiter.root.x, waiter.root.y, [box, label]).setScale(0.6).setAlpha(0);
    waiter.bubble = bubble;
    this.syncWaiterTag(waiter);
    this.tweens.add({ targets: bubble, scale: 1, alpha: 1, duration: 200, ease: 'Back.easeOut' });
    waiter.bubbleTimer = this.time.delayedCall(3400, () => {
      if (!bubble.active) return;
      this.tweens.add({
        targets: bubble,
        alpha: 0,
        duration: 280,
        onComplete: () => { bubble.destroy(); if (waiter.bubble === bubble) waiter.bubble = undefined; },
      });
    });
  }

  private leaveWaiter(waiter: WaiterView) {
    waiter.bubbleTimer?.remove();
    waiter.bubble?.destroy();
    waiter.bubble = undefined;
    this.leavingWaiters.add(waiter);
    this.tweens.killTweensOf(waiter.root);
    this.tweens.add({
      targets: waiter.root,
      x: WAIT_ENTRANCE.x,
      y: WAIT_ENTRANCE.y,
      alpha: 0,
      duration: 750,
      ease: 'Sine.easeIn',
      onComplete: () => {
        this.leavingWaiters.delete(waiter);
        this.tweens.killTweensOf(waiter.sprite);
        waiter.root.destroy();
        waiter.tag.destroy();
      },
    });
    this.tweens.add({ targets: waiter.tag, alpha: 0, duration: 550 });
  }

  private boardFromQueue(waiter: WaiterView, seatIndex: number, occupant: SeatOccupant) {
    this.boardingIds.add(occupant.id);
    waiter.bubbleTimer?.remove();
    this.waiterBubble(waiter, occupant.hometown ? `Về ${shortName(occupant.hometown, 12)}!` : 'Lên xe!');
    this.leavingWaiters.add(waiter);
    this.tweens.killTweensOf(waiter.root);
    waiter.root.setDepth(50);
    waiter.tag.setDepth(5050);
    const doorStop = { x: DOOR.x + 22, y: DOOR.y + 34 };
    this.tweens.add({
      targets: waiter.sprite,
      angle: { from: -6, to: 6 },
      duration: 110,
      yoyo: true,
      repeat: 4,
      onComplete: () => { if (waiter.sprite.active) waiter.sprite.setAngle(0); },
    });
    this.tweens.add({
      targets: waiter.root,
      x: doorStop.x,
      y: doorStop.y,
      duration: 500,
      ease: 'Sine.easeInOut',
      onComplete: () => {
        const point = this.seatWorld(seatIndex);
        this.tweens.add({ targets: waiter.tag, alpha: 0, duration: 280 });
        this.tweens.add({
          targets: waiter.root,
          x: point.x,
          y: point.y + 18,
          scale: 0.56,
          alpha: 0.35,
          duration: 460,
          ease: 'Back.easeOut',
          onComplete: () => {
            this.leavingWaiters.delete(waiter);
            this.tweens.killTweensOf(waiter.sprite);
            waiter.bubble?.destroy();
            waiter.root.destroy();
            waiter.tag.destroy();
            this.boardingIds.delete(occupant.id);
            const seat = this.seats[seatIndex];
            if (!this.departing && this.bus?.active && seat?.occupant?.id === occupant.id) {
              this.paintSeat(seat, seat.occupant, true);
              const world = this.seatWorld(seatIndex);
              this.fx.burst(world.x, world.y, 'spark', 10, 72);
              seat.root.setScale(1.16);
              this.tweens.add({ targets: seat.root, scale: 1, duration: 280, ease: 'Back.easeOut' });
            }
          },
        });
      },
    });
  }

  private syncWaiting(waiting: WaitingViewer[], seatedById: Map<string, { index: number; occupant: SeatOccupant }>) {
    const visibleList = waiting.slice(0, WAIT_SLOTS.length);
    const keepIds = new Set(visibleList.map(viewer => viewer.id));
    for (const [id, waiter] of this.waiters) {
      if (keepIds.has(id)) continue;
      this.waiters.delete(id);
      const seated = seatedById.get(id);
      if (seated && !this.departing && this.bus?.active) {
        this.boardFromQueue(waiter, seated.index, seated.occupant);
      } else {
        this.leaveWaiter(waiter);
      }
    }
    visibleList.forEach((viewer, index) => {
      const slot = WAIT_SLOTS[index];
      const existing = this.waiters.get(viewer.id);
      if (!existing) {
        const waiter = this.createWaiter(viewer, slot.x, slot.y, this.queueReady, 'Mới vào bến!');
        this.waiters.set(viewer.id, waiter);
      } else {
        const previous = existing.viewer;
        existing.viewer = viewer;
        if (previous.skin !== viewer.skin) {
          existing.sprite.setTexture(viewer.skin % 2 ? 'girl_wait' : 'boy_wait').setDisplaySize(WAIT_FIGURE, WAIT_FIGURE).setTint(WAIT_SKIN_TINT[viewer.skin % 4]);
        }
        if (previous.avatar !== viewer.avatar || previous.nickname !== viewer.nickname || previous.skin !== viewer.skin) {
          existing.face.setTexture(this.faces.key(viewer)).setDisplaySize(WAIT_FACE, WAIT_FACE);
          this.paintWaiterTag(existing);
        }
        if (existing.x !== slot.x || existing.y !== slot.y) {
          this.walkWaiter(existing, slot.x, slot.y, 460);
        }
      }
    });
    this.queueReady = true;
    if (this.queueHeader) {
      this.queueHeader.count.setText(waiting.length ? `${waiting.length} khách đang xếp hàng` : 'Chưa có khách chờ');
      const overflow = waiting.length - WAIT_SLOTS.length;
      this.queueHeader.more.setVisible(overflow > 0).setText(overflow > 0 ? `+${overflow} khách nữa` : '');
    }
  }

  private formatLedProvinces(route: StationRoute, sliceIndex: number) {
    const list = (route.provinces?.length ? route.provinces : route.stops).map(name => name.replace(/ /g, '\u00A0'));
    if (list.length <= 3) return list.join(' → ');
    const windowSize = 3;
    const totalWindows = Math.ceil(list.length / windowSize);
    const start = ((sliceIndex % totalWindows) + totalWindows) % totalWindows * windowSize;
    return list.slice(start, start + windowSize).join(' → ');
  }

  private paintInfo(route: StationRoute) {
    this.banner?.setText(`${route.label.toUpperCase()} · XE SỐ ${route.bus.number}`);
    this.led?.title.setText(route.label.toUpperCase());
    this.ledSlice = Math.floor(Date.now() / 3200);
    this.led?.stops.setText(this.formatLedProvinces(route, this.ledSlice));
    this.led?.info.setText(`${route.bus.filled}/${route.bus.capacity} ghế · ${route.minutes} phút`);
  }

  update() {
    for (const waiter of this.waiters.values()) this.syncWaiterTag(waiter);
    for (const waiter of this.leavingWaiters) this.syncWaiterTag(waiter);
    if (this.route && !this.pending?.session.paused) {
      const currentSlice = Math.floor(Date.now() / 3200);
      if (currentSlice !== this.ledSlice) {
        this.ledSlice = currentSlice;
        if (this.led?.stops) {
          this.led.stops.setText(this.formatLedProvinces(this.route, currentSlice)).setAlpha(0.35);
          this.tweens.add({ targets: this.led.stops, alpha: 1, duration: 240, ease: 'Sine.easeOut' });
        }
      }
    }
    const bus = this.route?.bus;
    if (!this.countdown) return;
    if (!bus || bus.full_at == null || this.departing) { this.countdown.setVisible(false); return; }
    const left = Math.max(0, Math.ceil((this.pending?.station.depart_delay ?? 10) - (Date.now() / 1000 + this.clockOffset - bus.full_at)));
    this.countdown.setText(left > 0 ? `XE ĐẦY · XUẤT BẾN ${left}s` : 'XUẤT BẾN!').setVisible(true);
  }

  private depart(passengers: number) {
    const bus = this.bus;
    if (!bus || this.departing) return;
    this.departing = true;
    this.boardingIds.clear();
    this.idleTween?.stop();
    this.idleTween = undefined;
    bus.y = BUS_Y;
    this.setWheelsSpinning(true);
    this.countdown?.setVisible(false);
    for (const bubble of this.bubbles.values()) bubble.destroy();
    this.bubbles.clear();
    for (let index = 0; index < 7; index++) {
      this.time.delayedCall(index * 160, () => {
        if (bus.active) this.fx.burst(bus.x - 140 + (Math.random() - 0.5) * 60, bus.y + BUS_H + 16, 'puff', 3, 65);
      });
    }
    this.fx.confetti(48);
    this.fx.fireworks(2);
    this.fx.floatText(540, 820, `Xuất bến · ${passengers} hành khách`, '#b0331f', 36);
    this.tweens.add({
      targets: bus, y: -BUS_H - 200, duration: 1700, ease: 'Cubic.easeIn', delay: 500,
      onComplete: () => {
        this.departing = false;
        this.setWheelsSpinning(false);
        bus.destroy();
        if (this.bus === bus) this.bus = undefined;
        this.shownBus = null;
        const next = this.queued ?? this.route;
        this.queued = undefined;
        if (next) { this.route = next; this.showBus(next, false); this.paintInfo(next); }
      },
    });
  }

  private walkIn(seatIndex: number, occupant: SeatOccupant) {
    const sprite = this.add.image(0, 0, occupant.skin % 2 ? 'girl_walk' : 'boy_walk').setOrigin(0.5, 1).setDisplaySize(120, 120);
    const suitcase = this.add.graphics();
    suitcase.fillStyle([0xd8452f, 0x3f7d9e, 0xe0a43a, 0x6f8a66][occupant.skin % 4]).fillRoundedRect(30, -46, 30, 40, 6);
    suitcase.fillStyle(0x2b2522).fillRect(40, -56, 10, 10).fillCircle(36, -4, 4).fillCircle(54, -4, 4);
    const walker = this.add.container(960, H + 140, [suitcase, sprite]).setDepth(50);
    this.tweens.add({ targets: sprite, angle: { from: -5, to: 5 }, duration: 140, yoyo: true, repeat: 6 });
    this.tweens.add({
      targets: walker, x: DOOR.x + 40, y: DOOR.y + 40, duration: 1300, ease: 'Sine.easeInOut',
      onComplete: () => {
        const point = this.seatWorld(seatIndex);
        this.tweens.add({
          targets: walker, x: point.x, y: point.y + 20, alpha: 0, scale: 0.55, duration: 380, ease: 'Back.easeOut',
          onComplete: () => walker.destroy(),
        });
        const seat = this.seats[seatIndex];
        if (!this.departing && this.bus?.active && seat?.occupant?.id === occupant.id) {
          this.fx.burst(point.x, point.y, 'spark', 10, 70);
          seat.root.setScale(1.14);
          this.tweens.add({ targets: seat.root, scale: 1, duration: 280, ease: 'Back.easeOut' });
        }
      },
    });
  }

  private bubbleAt(seatIndex: number, text: string, tone: 'chat' | 'alert' = 'chat') {
    this.bubbles.get(seatIndex)?.destroy();
    const point = this.seatWorld(seatIndex);
    const belowSeat = seatIndex < 4;
    const label = this.add.text(0, belowSeat ? 10 : -10, [...text].slice(0, 40).join(''), {
      fontFamily: FONT, fontSize: '19px', fontStyle: '600',
      color: tone === 'alert' ? '#8a2b19' : '#3e2412',
      align: 'center', wordWrap: { width: 250, useAdvancedWrap: true }, resolution: 2,
    }).setOrigin(0.5, belowSeat ? 0 : 1);
    const width = Math.ceil(label.width + 26);
    const height = Math.ceil(label.height + 16);
    const box = this.add.graphics();
    const fill = tone === 'alert' ? 0xffe7a6 : 0xfff8ea;
    if (belowSeat) {
      box.fillStyle(fill, 0.97).fillRoundedRect(-width / 2, 2, width, height, 14).fillTriangle(-9, 3, 9, 3, 0, -9);
      box.lineStyle(2, 0xd59a45).strokeRoundedRect(-width / 2, 2, width, height, 14);
    } else {
      box.fillStyle(fill, 0.97).fillRoundedRect(-width / 2, -height - 2, width, height, 14).fillTriangle(-9, -3, 9, -3, 0, 9);
      box.lineStyle(2, 0xd59a45).strokeRoundedRect(-width / 2, -height - 2, width, height, 14);
    }
    const x = Math.round(Math.max(width / 2 + 116, Math.min(W - width / 2 - 116, point.x)));
    const y = Math.round(belowSeat ? point.y + SEAT_H / 2 + 8 : point.y - SEAT_H / 2);
    const bubble = this.add.container(x, y, [box, label]).setDepth(6000).setScale(0.6).setAlpha(0);
    this.bubbles.set(seatIndex, bubble);
    this.tweens.add({ targets: bubble, scale: 1, alpha: 1, duration: 220, ease: 'Back.easeOut' });
    this.time.delayedCall(4600, () => this.tweens.add({ targets: bubble, alpha: 0, duration: 300, onComplete: () => { bubble.destroy(); if (this.bubbles.get(seatIndex) === bubble) this.bubbles.delete(seatIndex); } }));
  }

  private notice(event: GameResult) {
    const name = event.player?.nickname ?? '';
    const playerId = event.player?.id;
    const index = this.seatOf(playerId);
    const waiter = playerId ? this.waiters.get(playerId) : undefined;
    if (index >= 0) this.bubbleAt(index, event.message, 'alert');
    else if (waiter) this.waiterBubble(waiter, event.message, 'alert');
    else this.fx.floatText(SIDE_SPOT.x - 160, SIDE_SPOT.y - 220, shortName(`${name}: ${event.message}`, 34), '#8a2b19', 24);
  }

  react(event: GameResult) {
    if (!this.ready || event.duplicate) return;
    if (!event.ok) { if (event.broadcast) this.notice(event); return; }
    const playerId = event.player?.id ?? event.viewer?.id;
    const index = this.seatOf(playerId);
    const waiter = playerId ? this.waiters.get(playerId) : undefined;
    const spot = index >= 0 ? this.seatWorld(index) : waiter ? { x: waiter.root.x, y: waiter.root.y - WAIT_FACE_Y } : SIDE_SPOT;
    switch (event.code) {
      case 'ENTERED':
      case 'RETURNED': {
        const bubbleText = event.code === 'ENTERED' ? 'Mới vào bến!' : 'Đang xếp hàng';
        if (waiter) {
          if (!this.tweens.isTweening(waiter.root)) this.waveWaiter(waiter);
          this.waiterBubble(waiter, bubbleText);
        } else if (event.viewer?.id && this.waiters.size < WAIT_SLOTS.length) {
          const slot = WAIT_SLOTS[this.waiters.size];
          const created = this.createWaiter({
            id: event.viewer.id,
            name: event.viewer.name,
            nickname: event.viewer.nickname,
            skin: event.viewer.skin ?? 0,
            avatar: event.viewer.avatar,
            hometown: event.viewer.hometown,
            entered_at: event.viewer.entered_at ?? Date.now() / 1000,
          }, slot.x, slot.y, true, bubbleText);
          this.waiters.set(event.viewer.id, created);
        }
        break;
      }
      case 'SEATED':
      case 'MOVED_SEAT':
        if (event.ticket && this.shownBus?.route === event.ticket.route && this.shownBus.number === event.ticket.bus_number && event.player) {
          const seatIdx = event.ticket.seat - 1;
          if (event.code === 'SEATED') {
            if (!this.boardingIds.has(event.player.id)) {
              this.walkIn(seatIdx, { id: event.player.id, nickname: event.player.nickname, skin: event.player.skin, avatar: event.player.avatar, hometown: event.ticket.hometown });
            }
          } else {
            this.fx.burst(this.seatWorld(seatIdx).x, this.seatWorld(seatIdx).y, 'spark', 8, 60);
          }
          if (event.ticket.hometown) {
            const delay = this.boardingIds.has(event.player.id) ? 980 : 0;
            this.time.delayedCall(delay, () => {
              if (!this.departing && this.seats[seatIdx]?.occupant?.id === event.player?.id) {
                this.bubbleAt(seatIdx, `Về ${event.ticket!.hometown} · Ghế ${event.ticket!.seat}`, 'chat');
              }
            });
          }
        }
        break;
      case 'CONFIRM_SWITCH':
      case 'ALREADY_SEATED':
      case 'NO_TICKET':
        this.notice(event);
        break;
      case 'TICKET':
        if (index >= 0) this.bubbleAt(index, `Ghế ${event.ticket?.seat}${event.ticket?.hometown ? ` · ${event.ticket.hometown}` : ''} · ${event.ticket?.route_label}`, 'alert');
        break;
      case 'DEPARTED':
        // The shown bus already drives off from applyState; buses of other routes just get a notice.
        if (!this.departing && event.bus && this.shownBus?.route !== event.bus.route) this.fx.floatText(540, 820, event.message.split('·')[0], '#b0331f', 30);
        break;
      case 'CHAT':
        if (index >= 0 && event.text) this.bubbleAt(index, event.text);
        else if (waiter && event.text) this.waiterBubble(waiter, event.text);
        break;
      case 'LIKED':
        this.fx.hearts(spot.x, spot.y, Math.min(6, 1 + Math.floor((event.count ?? 1) / 6)));
        break;
      case 'BOOST':
        this.fx.hearts(540, 1000, 8);
        this.cameras.main.flash(500, 255, 170, 190, false);
        this.fx.floatText(540, 820, 'QUÀ ĂN ĐƯỜNG!', '#d8345a', 50);
        break;
      case 'FOLLOWED':
        this.fx.hearts(spot.x, spot.y, 6);
        this.fx.floatText(spot.x, spot.y - 50, 'Ký hợp đồng!', '#b0331f');
        break;
      case 'SHARED':
        this.fx.burst(spot.x, spot.y, 'spark', 12, 100);
        break;
      case 'GIFTED': {
        const tier = event.gift?.tier ?? 'lixi';
        this.fx.burst(spot.x, spot.y, 'coin', tier === 'lixi' ? 8 : 14, 150);
        if (tier !== 'lixi') this.fx.confetti(tier === 'party' ? 70 : 34);
        if (tier === 'party') { this.fx.fireworks(4); this.cameras.main.flash(450, 255, 225, 150, false); }
        break;
      }
    }
  }
}
