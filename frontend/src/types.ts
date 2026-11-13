export interface Player {
  id: string;
  nickname: string;
  skin: number;
  kpi: number;
  coins: number;
  xp: number;
  last_work: number;
  last_seen: number;
  mission_works: number;
  missions_completed: number;
  avatar: string;
  hearts: number;
  gifts: number;
  followed: number;
}

export interface Activity {
  id: number;
  seq: number;
  type: string;
  nickname: string | null;
  player_id: string | null;
  message: string;
  created_at: number;
}

export type LiveStatusName = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error' | 'ended' | 'mock';

export interface LiveStatus {
  status: LiveStatusName;
  unique_id: string;
  room_id: string;
  error: string;
  code: string;
  viewer_count: number | null;
  since: number | null;
  counters: { chat: number; like: number; gift: number; follow: number; share: number; enter: number; duplicate: number; dropped: number };
  queue: number;
}

export interface GiftTier { key: 'lixi' | 'treat' | 'party'; min: number; label: string; reward: number; refresh: boolean }

export interface SeatOccupant { id: string; nickname: string; skin: number; avatar: string; hometown?: string }

export interface WaitingViewer {
  id: string;
  name?: string;
  nickname: string;
  skin: number;
  avatar: string;
  hometown?: string;
  entered_at: number;
}

export interface StationRoute {
  code: string;
  label: string;
  stops: string[];
  provinces?: string[];
  minutes: number;
  color: string;
  bus: { id: number | null; number: number; filled: number; capacity: number; countdown: number | null; full_at: number | null; seats: (SeatOccupant | null)[] };
  boarding_buses: number;
  seated: number;
  departed_buses: number;
  riders: number;
}

export interface StationState { routes: StationRoute[]; focus: string; capacity: number; depart_delay: number; switch_window: number; waiting?: WaitingViewer[] }

export interface Ticket { bus_id: number; route: string; route_label: string; bus_number: number; seat: number; color: string; hometown?: string }

export interface GameState {
  session: { id: string; phase: 'OFFICE' | 'BONUS'; month: number; paused: boolean; version: number; created_at: number; play_mode: 'open' | 'scheduled'; scene: 'office' | 'station'; route: string };
  players: Player[];
  leaderboard: Player[];
  top_hearts: Player[];
  top_gifts: Player[];
  activities: Activity[];
  stats: { total_players: number; total_kpi: number; total_coins: number; visible_players: number; visible_limit: number; company_target: number; demo_players: number };
  server_time: number;
  mode: 'mock' | 'live';
  audience: { connected: boolean; viewer_count: number | null };
  mission: { target: number; reward: number };
  work_cooldown: number;
  energy: { hearts: number; target: number; boosts: number };
  rewards: { follow: number; share: number; gift_tiers: GiftTier[] };
  live: LiveStatus;
  station: StationState;
}

export interface GameResult {
  ok: boolean;
  changed: boolean;
  code: string;
  message: string;
  seq?: number;
  event_id?: string;
  duplicate?: boolean;
  broadcast?: boolean;
  cue?: 'join' | 'work' | 'coffee' | 'salary' | 'bonus' | 'month' | 'boss' | 'click' | 'horn' | 'depart';
  voice?: 'welcome' | 'boss' | 'month' | 'bonus' | 'station' | 'depart';
  action?: string;
  kind?: string;
  player?: Player;
  remaining?: number;
  mission_completed?: boolean;
  joined?: boolean;
  count?: number;
  boost?: boolean;
  text?: string;
  viewer?: { id?: string; name?: string; nickname: string; skin?: number; avatar: string; hometown?: string; entered_at?: number };
  gift?: { name: string; count: number; diamonds: number; tier: GiftTier['key']; label: string; reward: number };
  ticket?: Ticket;
  moved_from?: { bus_id: number; seat: number; route: string } | null;
  bus_full?: boolean;
  bus?: { id: number; route: string; number: number; passengers: number; first_trips: number; minutes: number };
  seat?: { bus_id: number; seat: number; route: string };
  suggestion?: number | null;
  reason?: string;
  state?: GameState;
}
