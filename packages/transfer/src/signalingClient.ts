import type {
  ClientToServerMsg,
  DeviceInfo,
  RoomCreatedMsg,
  RoomJoinedMsg,
  ServerToClientMsg,
  SignalDeliverMsg,
} from "@dropbeam/protocol";

type Listener = (m: ServerToClientMsg) => void;
type SignalListener = (data: unknown, from: string) => void;

export interface SignalingClientOptions {
  url: string;
  device: DeviceInfo;
  /** Provide a WebSocket implementation. In browsers pass `WebSocket`. In Node, `ws` or `Bun`. */
  webSocketImpl?: typeof WebSocket;
  /**
   * Send an application-level ping this often (ms) so proxies / PaaS load
   * balancers don't reap an idle socket while a peer is still deciding to
   * join. 0 disables. Default 20 s.
   */
  keepAliveMs?: number;
}

/** Thrown / passed to `onClose` listeners when the socket goes away. */
export class SignalingClosedError extends Error {
  constructor(message = "Lost connection to the signaling server.") {
    super(message);
    this.name = "SignalingClosedError";
  }
}

/** Max signals buffered for a peer nobody is listening to yet. */
const MAX_BUFFERED_SIGNALS = 256;

/**
 * Thin WS client. Doesn't manage transfer state — only rooms/relay.
 *
 * Signal delivery guarantees:
 *   - Any number of listeners may subscribe to the same peer.
 *   - Signals that arrive before anyone subscribed to that peer are buffered
 *     and replayed to the first subscriber, so an SDP offer can't be lost
 *     to a race between `joinRoom()` resolving and the caller wiring up.
 */
export class SignalingClient {
  private ws!: WebSocket;
  private listeners = new Set<Listener>();
  private signalListeners = new Map<string, Set<SignalListener>>();
  private bufferedSignals = new Map<string, unknown[]>();
  private closeListeners = new Set<(err: SignalingClosedError) => void>();
  private opened: Promise<void>;
  private resolveOpened!: () => void;
  private rejectOpened!: (e: Error) => void;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private closedByUs = false;
  /** True once the socket has closed (for any reason). */
  closed = false;
  /** Convenience: assigned after create-room or join-room resolves. */
  myPeerId: string | null = null;

  constructor(private readonly opts: SignalingClientOptions) {
    this.opened = new Promise((res, rej) => {
      this.resolveOpened = res;
      this.rejectOpened = rej;
    });
    // Avoid unhandled-rejection noise if nobody awaits ready().
    this.opened.catch(() => {});
    this.connect();
  }

  private connect(): void {
    const Impl = this.opts.webSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!Impl) throw new Error("no WebSocket impl available");
    try {
      this.ws = new Impl(this.opts.url);
    } catch (e) {
      // e.g. SyntaxError for a malformed URL, SecurityError for ws:// on https.
      this.closed = true;
      this.rejectOpened(new SignalingClosedError(`Can't open signaling connection: ${(e as Error).message}`));
      return;
    }
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => {
      this.resolveOpened();
      const every = this.opts.keepAliveMs ?? 20_000;
      if (every > 0) {
        this.keepAlive = setInterval(() => {
          if (this.ws.readyState === 1) this.send({ type: "ping", t: Date.now() });
        }, every);
      }
    };
    this.ws.onerror = () => {
      this.rejectOpened(new SignalingClosedError(`Can't reach the signaling server at ${this.opts.url}.`));
    };
    this.ws.onclose = () => {
      this.closed = true;
      if (this.keepAlive) clearInterval(this.keepAlive);
      this.keepAlive = null;
      const err = new SignalingClosedError(
        this.closedByUs ? "Signaling connection closed." : "Lost connection to the signaling server.",
      );
      this.rejectOpened(err);
      for (const fn of [...this.closeListeners]) fn(err);
      this.closeListeners.clear();
    };
    this.ws.onmessage = (ev) => {
      let parsed: ServerToClientMsg;
      try {
        parsed = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer)) as ServerToClientMsg;
      } catch {
        return;
      }
      if (parsed.type === "signal") this.deliverSignal(parsed as SignalDeliverMsg);
      for (const l of [...this.listeners]) l(parsed);
    };
  }

  private deliverSignal(sig: SignalDeliverMsg): void {
    const subs = this.signalListeners.get(sig.from);
    if (subs && subs.size) {
      for (const fn of [...subs]) fn(sig.data, sig.from);
      return;
    }
    let q = this.bufferedSignals.get(sig.from);
    if (!q) this.bufferedSignals.set(sig.from, (q = []));
    if (q.length < MAX_BUFFERED_SIGNALS) q.push(sig.data);
  }

  ready(): Promise<void> {
    return this.opened;
  }

  close(): void {
    if (this.closed) return;
    this.closedByUs = true;
    if (this.ws?.readyState === 1) {
      try {
        this.send({ type: "leave-room" });
      } catch {
        /* ignore */
      }
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Called once when the socket closes. Fires immediately if already closed. */
  onClose(fn: (err: SignalingClosedError) => void): () => void {
    if (this.closed) {
      queueMicrotask(() => fn(new SignalingClosedError()));
      return () => {};
    }
    this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }

  /**
   * Per-peer signal hook used by transfer setup. Multiple subscribers are
   * allowed; the first one also receives any signals buffered so far.
   */
  onSignalFrom(peerId: string, fn: SignalListener): () => void {
    let subs = this.signalListeners.get(peerId);
    if (!subs) this.signalListeners.set(peerId, (subs = new Set()));
    subs.add(fn);
    const buffered = this.bufferedSignals.get(peerId);
    if (buffered) {
      this.bufferedSignals.delete(peerId);
      for (const data of buffered) fn(data, peerId);
    }
    return () => {
      subs!.delete(fn);
    };
  }

  send(msg: ClientToServerMsg): void {
    if (this.ws?.readyState !== 1) throw new SignalingClosedError();
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
      const cleanup = (): void => {
        off();
        offClose();
      };
      const off = this.on((m) => {
        if (pred(m)) {
          cleanup();
          resolve(m);
        } else if (m.type === "error") {
          cleanup();
          reject(new Error(`${m.code}: ${m.message}`));
        }
      });
      const offClose = this.onClose((err) => {
        cleanup();
        reject(err);
      });
      try {
        this.send(out);
      } catch (e) {
        cleanup();
        reject(e as Error);
      }
    });
  }
}
