import type { GameResult, GameState } from './types';

export async function request<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`Máy chủ chưa xử lý được yêu cầu (${response.status}). Thử lại nhé.`);
  return response.json() as Promise<T>;
}

export class LiveConnection {
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private closed = false;
  private delay = 1000;

  constructor(private onState: (state: GameState, events: GameResult[]) => void, private onConnection: (connected: boolean) => void) {
    this.connect();
  }

  private connect() {
    if (this.closed) return;
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.socket = socket;
    socket.onopen = () => {
      if (this.closed) {
        socket.close();
        return;
      }
      this.delay = 1000;
      this.onConnection(true);
      this.heartbeat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send('ping'); }, 20000);
    };
    socket.onmessage = (message) => {
      if (this.closed) return;
      try {
        const data = JSON.parse(message.data);
        // Manual commands carry one `event`; LIVE batches carry an ordered `events` list.
        const events: GameResult[] = Array.isArray(data.events) ? data.events : data.event ? [data.event] : [];
        if (data.state) this.onState(data.state as GameState, events);
      } catch { /* A malformed frame cannot invalidate committed server state. */ }
    };
    socket.onclose = () => {
      clearInterval(this.heartbeat);
      if (this.closed) return;
      this.onConnection(false);
      this.retry = setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(10000, this.delay * 1.5);
    };
    socket.onerror = () => socket.close();
  }

  dispose() {
    this.closed = true;
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.close();
      this.socket = undefined;
    }
  }
}
