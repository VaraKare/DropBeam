/**
 * Signaling protocol — JSON messages exchanged over WebSocket between
 * peers and the signaling server. The server never sees file content;
 * its only job is to introduce peers and forward opaque WebRTC
 * SDP/ICE blobs (`SignalRelayMsg.data`).
 */

export type DeviceKind =
  | "browser"
  | "ios"
  | "android"
  | "macos"
  | "windows"
  | "linux"
  | "node"
  | "unknown";

export interface DeviceInfo {
  /** Stable per-install id chosen by the client; opaque to server. */
  deviceId: string;
  /** Human-readable name shown to the other peer ("Prasad's MacBook"). */
  name: string;
  kind: DeviceKind;
  /** Free-form for app/version/UA fingerprinting. */
  userAgent?: string;
}

// ─── client → server ──────────────────────────────────────────────────────

export interface CreateRoomMsg {
  type: "create-room";
  device: DeviceInfo;
  /** Optional TTL in seconds; server clamps to its max. */
  ttlSeconds?: number;
}

export interface JoinRoomMsg {
  type: "join-room";
  /** Either the long roomId or the short human code. */
  roomIdOrCode: string;
  device: DeviceInfo;
}

export interface SignalRelayMsg {
  type: "signal";
  /** Target peerId in the same room. */
  to: string;
  /** Opaque WebRTC SDP / ICE / app blob. Server does not inspect. */
  data: unknown;
}

export interface LeaveRoomMsg {
  type: "leave-room";
}

export interface PingMsg {
  type: "ping";
  t: number;
}

export type ClientToServerMsg =
  | CreateRoomMsg
  | JoinRoomMsg
  | SignalRelayMsg
  | LeaveRoomMsg
  | PingMsg;

// ─── server → client ──────────────────────────────────────────────────────

export interface RoomCreatedMsg {
  type: "room-created";
  roomId: string;
  /** Short human-friendly code, e.g. "428193". */
  code: string;
  /** This peer's id within the room. */
  peerId: string;
  /** Server-issued reconnect token (opaque). */
  token: string;
  expiresAt: number;
}

export interface RoomJoinedMsg {
  type: "room-joined";
  roomId: string;
  peerId: string;
  token: string;
  /** Other peers already in the room. */
  peers: Array<{ peerId: string; device: DeviceInfo }>;
  expiresAt: number;
}

export interface PeerJoinedMsg {
  type: "peer-joined";
  peerId: string;
  device: DeviceInfo;
}

export interface PeerLeftMsg {
  type: "peer-left";
  peerId: string;
  reason?: string;
}

export interface SignalDeliverMsg {
  type: "signal";
  /** Origin peerId. */
  from: string;
  data: unknown;
}

export interface PongMsg {
  type: "pong";
  t: number;
}

export interface ErrorMsg {
  type: "error";
  code:
    | "rate-limited"
    | "room-not-found"
    | "room-full"
    | "invalid-message"
    | "not-in-room"
    | "peer-not-found"
    | "internal";
  message: string;
}

export type ServerToClientMsg =
  | RoomCreatedMsg
  | RoomJoinedMsg
  | PeerJoinedMsg
  | PeerLeftMsg
  | SignalDeliverMsg
  | PongMsg
  | ErrorMsg;

// ─── runtime guards ───────────────────────────────────────────────────────

export function isClientMsg(v: unknown): v is ClientToServerMsg {
  if (typeof v !== "object" || v === null) return false;
  const t = (v as { type?: unknown }).type;
  return (
    t === "create-room" ||
    t === "join-room" ||
    t === "signal" ||
    t === "leave-room" ||
    t === "ping"
  );
}
