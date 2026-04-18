import type {
  ClientToServerMsg,
  DeviceInfo,
  RoomCreatedMsg,
  RoomJoinedMsg,
  ServerToClientMsg,
  SignalDeliverMsg,
} from "@dropbeam/protocol";

type Listener = (m: ServerToClientMsg) => void;

export interface SignalingClientOptions {
  url: string;
  device: DeviceInfo;
  /** Provide a WebSocket implementation. In browsers pass `WebSocket`. In Node, `ws` or `Bun`. */
  webSocketImpl?: typeof WebSocket;
}

/**
 * Thin WS client. Doesn't manage transfer state — only auth/rooms/relay.
 */
export class SignalingClient {
  private ws!: WebSocket;
  private listeners = new Set<Listener>();
  private signalListeners = new Map<string, (data: unknown, from: string) => void>();
  private opened: Promise<void>;
  private resolveOpened!: () => void;
  private rejectOpened!: (e: Error) => void;
  /** Convenience: assigned after create-room or join-room resolves. */
  myPeerId: string | null = null;

  constructor(private readonly opts: SignalingClientOptions) {
    this.opened = new Promise((res, rej) => {
      this.resolveOpened = res;
      this.rejectOpened = rej;
    });
    this.connect();
  }

  private connect(): void {
    const Impl = this.opts.webSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!Impl) throw new Error("no WebSocket impl available");
    this.ws = new Impl(this.opts.url);
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => this.resolveOpened();
    this.ws.onerror = (e) => this.rejectOpened(new Error("ws error: " + (e as Event).type));
    this.ws.onclose = () => {
      // host app can react via .on listener; we don't auto-reconnect by default.
    };
    this.ws.onmessage = (ev) => {
      let parsed: ServerToClientMsg;
      try {
        parsed = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer)) as ServerToClientMsg;
      } catch {
        return;
      }
      if (parsed.type === "signal") {
        const sig = parsed as SignalDeliverMsg;
        this.signalListeners.get(sig.from)?.(sig.data, sig.from);
      }
      for (const l of this.listeners) l(parsed);
    };
  }

  ready(): Promise<void> {
    return this.opened;
  }

  close(): void {
    try {
      this.send({ type: "leave-room" });
    } catch {}
    this.ws.close();
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Per-peer signal hook used by transfer setup. */
  onSignalFrom(peerId: string, fn: (data: unknown, from: string) => void): () => void {
    this.signalListeners.set(peerId, fn);
    return () => this.signalListeners.delete(peerId);
  }

  send(msg: ClientToServerMsg): void {
    this.ws.send(JSON.stringify(msg));
  }

  async createRoom(ttlSeconds?: number): Promise<RoomCreatedMsg> {
    await this.ready();
    return this.request<RoomCreatedMsg>(
      { type: "create-room", device: this.opts.device, ttlSeconds },
      (m): m is RoomCreatedMsg => m.type === "room-created",
    ).then((m) => {
      this.myPeerId = m.peerId;
      return m;
    });
  }

  async joinRoom(roomIdOrCode: string): Promise<RoomJoinedMsg> {
    await this.ready();
    return this.request<RoomJoinedMsg>(
      { type: "join-room", roomIdOrCode, device: this.opts.device },
      (m): m is RoomJoinedMsg => m.type === "room-joined",
    ).then((m) => {
      this.myPeerId = m.peerId;
      return m;
    });
  }

  signal(to: string, data: unknown): void {
    this.send({ type: "signal", to, data });
  }

  private request<T extends ServerToClientMsg>(
    out: ClientToServerMsg,
    pred: (m: ServerToClientMsg) => m is T,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const off = this.on((m) => {
        if (pred(m)) {
          off();
          resolve(m);
        } else if (m.type === "error") {
          off();
          reject(new Error(`${m.code}: ${m.message}`));
        }
      });
      this.send(out);
    });
  }
}
