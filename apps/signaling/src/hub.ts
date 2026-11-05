/**
 * Platform-neutral signaling logic: rooms, membership, rate limits and
 * message relay. The Bun server (`server.ts`) and the Cloudflare Durable
 * Object (`worker.ts`) are thin adapters that feed sockets into one Hub, so
 * both deployments behave identically and share one test suite.
 *
 * Rules (audit 2026-11-05, ADR-003): every message is strictly parsed; one
 * room per socket; rooms of `roomCapacity`; per-address rate limits and
 * connection caps; nothing about file contents ever passes through here.
 */

import {
  parseClientMsg,
  type ClientToServerMsg,
  type ServerToClientMsg,
} from "@dropbeam/protocol";
import { RateLimiter } from "./rateLimit.js";
import { RoomManager, type PeerSlot, type Room } from "./room.js";

export interface HubOptions {
  maxRooms: number;
  roomCapacity: number;
  maxConnections: number;
  maxConnectionsPerIp: number;
}

/** What the hub needs from a socket, whatever the runtime. */
export interface HubSocket {
  /** Client address used for limits (already resolved by the adapter). */
  readonly ip: string;
  send(text: string): void;
  /** Set by the hub. */
  room?: Room;
  peer?: PeerSlot;
}

const PRUNE_EVERY_MS = 30_000;

export class Hub {
  private readonly rooms: RoomManager;
  // Per-address message rate: 30 burst, refill 15/s.
  private readonly msgLimiter = new RateLimiter(30, 15);
  // Per-address room creation: 5 burst, refill 1 per 10 s.
  private readonly createLimiter = new RateLimiter(5, 0.1);
  private openConnections = 0;
  private readonly connectionsByIp = new Map<string, number>();
  private lastPrune = Date.now();
  private readonly startedAt = Date.now();

  constructor(private readonly opts: HubOptions) {
    this.rooms = new RoomManager({
      defaultTtlMs: 30 * 60 * 1000, // 30 min
      maxTtlMs: 4 * 60 * 60 * 1000, // 4 h
      maxRooms: opts.maxRooms,
      defaultCapacity: opts.roomCapacity,
    });
  }

  /**
   * Call before upgrading a connection. Returns an HTTP status + reason to
   * refuse with, or null to accept.
   */
  admit(ip: string): { status: number; reason: string } | null {
    if (this.openConnections >= this.opts.maxConnections) return { status: 503, reason: "server busy" };
    if ((this.connectionsByIp.get(ip) ?? 0) >= this.opts.maxConnectionsPerIp) {
      return { status: 429, reason: "too many connections" };
    }
    return null;
  }

  onOpen(ws: HubSocket): void {
    this.openConnections++;
    this.connectionsByIp.set(ws.ip, (this.connectionsByIp.get(ws.ip) ?? 0) + 1);
  }

  onClose(ws: HubSocket): void {
    this.openConnections = Math.max(0, this.openConnections - 1);
    const n = (this.connectionsByIp.get(ws.ip) ?? 1) - 1;
    if (n > 0) this.connectionsByIp.set(ws.ip, n);
    else this.connectionsByIp.delete(ws.ip);
    this.leaveCurrentRoom(ws, "disconnect");
  }

  onMessage(ws: HubSocket, raw: string): void {
    this.maybePrune();
    if (!this.msgLimiter.consume(ws.ip)) {
      this.reply(ws, { type: "error", code: "rate-limited", message: "Too many messages." });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.reply(ws, { type: "error", code: "invalid-message", message: "JSON parse error." });
      return;
    }
    const msg = parseClientMsg(parsed);
    if (!msg) {
      this.reply(ws, { type: "error", code: "invalid-message", message: "Malformed or unknown message." });
      return;
    }
    this.handle(ws, msg);
  }

  health(): { ok: true; rooms: number; connections: number; uptimeMs: number } {
    this.maybePrune();
    return {
      ok: true,
      rooms: this.rooms.count(),
      connections: this.openConnections,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  /** Drop expired rooms and idle limiter buckets (lazily, from normal traffic). */
  private maybePrune(): void {
    const now = Date.now();
    if (now - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    this.rooms.prune();
    this.msgLimiter.prune(60_000);
    this.createLimiter.prune(5 * 60_000);
  }

  private reply(ws: HubSocket, msg: ServerToClientMsg): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket already closing */
    }
  }

  private handle(ws: HubSocket, msg: ClientToServerMsg): void {
    switch (msg.type) {
      case "ping":
        this.reply(ws, { type: "pong", t: msg.t });
        return;

      case "create-room": {
        if (ws.room) {
          this.reply(ws, { type: "error", code: "already-in-room", message: "Leave the current room first." });
          return;
        }
        if (!this.createLimiter.consume(ws.ip)) {
          this.reply(ws, { type: "error", code: "rate-limited", message: "Too many room creations." });
          return;
        }
        try {
          const { room, peer } = this.rooms.create(msg.device, msg.ttlSeconds);
          peer.send = (m) => this.reply(ws, m);
          ws.room = room;
          ws.peer = peer;
          this.reply(ws, {
            type: "room-created",
            roomId: room.roomId,
            code: room.code,
            peerId: peer.peerId,
            token: peer.token,
            expiresAt: room.expiresAt,
          });
        } catch (e) {
          const full = (e as Error).message === "server-full";
          this.reply(ws, {
            type: "error",
            code: full ? "server-full" : "internal",
            message: full ? "The server is at capacity. Try again shortly." : "Could not create a room.",
          });
        }
        return;
      }

      case "join-room": {
        if (ws.room) {
          this.reply(ws, { type: "error", code: "already-in-room", message: "Leave the current room first." });
          return;
        }
        try {
          const { room, peer } = this.rooms.join(msg.roomIdOrCode, msg.device);
          peer.send = (m) => this.reply(ws, m);
          ws.room = room;
          ws.peer = peer;
          const others = [...room.peers.values()]
            .filter((p) => p.peerId !== peer.peerId)
            .map((p) => ({ peerId: p.peerId, device: p.device }));
          this.reply(ws, {
            type: "room-joined",
            roomId: room.roomId,
            peerId: peer.peerId,
            token: peer.token,
            peers: others,
            expiresAt: room.expiresAt,
          });
          this.broadcast(room, peer.peerId, { type: "peer-joined", peerId: peer.peerId, device: peer.device });
        } catch (e) {
          const m = (e as Error).message;
          if (m === "room-not-found") {
            this.reply(ws, { type: "error", code: "room-not-found", message: "Room not found or expired." });
          } else if (m === "room-full") {
            this.reply(ws, { type: "error", code: "room-full", message: "Room is full." });
          } else {
            this.reply(ws, { type: "error", code: "internal", message: "Could not join the room." });
          }
        }
        return;
      }

      case "signal": {
        const { room, peer } = ws;
        if (!room || !peer) {
          this.reply(ws, { type: "error", code: "not-in-room", message: "Join a room first." });
          return;
        }
        const target = room.peers.get(msg.to);
        if (!target || !target.send) {
          this.reply(ws, { type: "error", code: "peer-not-found", message: `Peer ${msg.to} not connected.` });
          return;
        }
        target.send({ type: "signal", from: peer.peerId, data: msg.data });
        return;
      }

      case "leave-room":
        this.leaveCurrentRoom(ws, "leave");
        return;
    }
  }

  /** Remove the socket from its room (if any) and tell the other peer. */
  private leaveCurrentRoom(ws: HubSocket, reason: "leave" | "disconnect"): void {
    const { room, peer } = ws;
    ws.room = undefined;
    ws.peer = undefined;
    if (!room || !peer) return;
    peer.send = null;
    this.rooms.leave(room, peer.peerId);
    this.broadcast(room, peer.peerId, { type: "peer-left", peerId: peer.peerId, reason });
  }

  private broadcast(room: Room, exceptPeerId: string, msg: ServerToClientMsg): void {
    for (const p of room.peers.values()) {
      if (p.peerId !== exceptPeerId) p.send?.(msg);
    }
  }
}
