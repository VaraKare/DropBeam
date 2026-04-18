import type {
  DeviceInfo,
  ServerToClientMsg,
} from "@dropbeam/protocol";
import {
  makePeerId,
  makeRoomCode,
  makeRoomId,
  makeToken,
  normalizeCode,
} from "./codes.js";

export interface PeerSlot {
  peerId: string;
  device: DeviceInfo;
  token: string;
  /** Active socket; null while disconnected (waiting for reconnect). */
  send: ((msg: ServerToClientMsg) => void) | null;
  joinedAt: number;
}

export interface Room {
  roomId: string;
  code: string;
  peers: Map<string, PeerSlot>;
  createdAt: number;
  expiresAt: number;
  /** Soft cap on peers per room (typically 2 for 1:1; bumped for multicast). */
  capacity: number;
}

export interface RoomManagerOptions {
  /** Default and max TTL for a room, in ms. */
  defaultTtlMs: number;
  maxTtlMs: number;
  /** Max concurrent rooms; new creates rejected past this. */
  maxRooms: number;
  /** Default per-room peer capacity. */
  defaultCapacity: number;
}

export class RoomManager {
  private byId = new Map<string, Room>();
  private byCode = new Map<string, Room>();

  constructor(private readonly opts: RoomManagerOptions) {}

  count(): number {
    return this.byId.size;
  }

  create(device: DeviceInfo, ttlSeconds?: number): {
    room: Room;
    peer: PeerSlot;
  } {
    if (this.byId.size >= this.opts.maxRooms) {
      throw new Error("server-full");
    }
    const ttl = Math.min(
      this.opts.maxTtlMs,
      ttlSeconds ? ttlSeconds * 1000 : this.opts.defaultTtlMs,
    );
    const room: Room = {
      roomId: makeRoomId(),
      code: this.uniqueCode(),
      peers: new Map(),
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl,
      capacity: this.opts.defaultCapacity,
    };
    const peer: PeerSlot = {
      peerId: makePeerId(),
      device,
      token: makeToken(),
      send: null,
      joinedAt: Date.now(),
    };
    room.peers.set(peer.peerId, peer);
    this.byId.set(room.roomId, room);
    this.byCode.set(normalizeCode(room.code), room);
    return { room, peer };
  }

  /** Look up by either roomId or short code (case-insensitive, dashes ignored). */
  find(roomIdOrCode: string): Room | undefined {
    const direct = this.byId.get(roomIdOrCode);
    if (direct) return direct;
    return this.byCode.get(normalizeCode(roomIdOrCode));
  }

  join(
    roomIdOrCode: string,
    device: DeviceInfo,
  ): { room: Room; peer: PeerSlot } {
    const room = this.find(roomIdOrCode);
    if (!room) throw new Error("room-not-found");
    if (room.expiresAt < Date.now()) {
      this.delete(room.roomId);
      throw new Error("room-not-found");
    }
    if (room.peers.size >= room.capacity) throw new Error("room-full");
    const peer: PeerSlot = {
      peerId: makePeerId(),
      device,
      token: makeToken(),
      send: null,
      joinedAt: Date.now(),
    };
    room.peers.set(peer.peerId, peer);
    return { room, peer };
  }

  leave(room: Room, peerId: string): void {
    room.peers.delete(peerId);
    if (room.peers.size === 0) this.delete(room.roomId);
  }

  delete(roomId: string): void {
    const room = this.byId.get(roomId);
    if (!room) return;
    this.byId.delete(roomId);
    this.byCode.delete(normalizeCode(room.code));
  }

  /** Drop expired rooms; call on a timer. */
  prune(): number {
    const now = Date.now();
    let n = 0;
    for (const [id, room] of this.byId) {
      if (room.expiresAt < now) {
        this.byId.delete(id);
        this.byCode.delete(normalizeCode(room.code));
        n++;
      }
    }
    return n;
  }

  private uniqueCode(): string {
    for (let i = 0; i < 8; i++) {
      const c = makeRoomCode();
      if (!this.byCode.has(normalizeCode(c))) return c;
    }
    throw new Error("could-not-allocate-code");
  }
}
