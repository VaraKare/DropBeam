/**
 * Adapter: werift `RTCPeerConnection` → DropBeam `PeerConnection`.
 *
 * werift's API uses rxjs-style `.subscribe` events instead of DOM
 * `onfoo = ...` properties. This file translates between them so the
 * runtime-agnostic transfer engine can drive a Node-side WebRTC stack.
 *
 * Compatible with werift ^0.20. If the upstream API changes, fix here.
 */

import {
  RTCIceCandidate,
  RTCPeerConnection,
  type RTCDataChannel,
} from "werift";
import type {
  DataChannel,
  IceCandidate,
  PeerConnection,
  SessionDescription,
} from "@dropbeam/transfer";

const STUN_DEFAULT = "stun:stun.l.google.com:19302";

export interface WeriftAdapterOptions {
  iceServers?: { urls: string | string[]; username?: string; credential?: string }[];
}

export function makeWeriftPeer(opts: WeriftAdapterOptions = {}): PeerConnection {
  const defaultIceServers = [
    // 1. First attempt: Direct P2P via Google's free STUN (Fastest)
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    
    // 2. Fallback: TURN servers for strict NATs/Firewalls (Guarantees connection)
    // NOTE: For production, you will need a paid TURN service like Twilio, Metered, or Coturn.
    // Replace these credentials with your actual TURN provider later.
    {
      urls: 'turn:global.turn.twilio.com:3478?transport=udp',
      username: 'YOUR_TURN_USERNAME',
      credential: 'YOUR_TURN_PASSWORD'
    }
  ];

  const pc = new RTCPeerConnection({
    iceServers: (opts.iceServers ?? defaultIceServers) as any,
  });
  return wrap(pc);
}

function wrap(pc: RTCPeerConnection): PeerConnection {
  const adapter: PeerConnection = {
    onicecandidate: null,
    ondatachannel: null,
    oniceconnectionstatechange: null,
    onconnectionstatechange: null,

    createDataChannel(label, init) {
      const ch = pc.createDataChannel(label, {
        ordered: init?.ordered ?? true,
        maxRetransmits: init?.maxRetransmits,
      });
      return wrapChannel(ch);
    },

    async createOffer() {
      const o = await pc.createOffer();
      return { type: o.type as "offer", sdp: o.sdp };
    },
    async createAnswer() {
      const a = await pc.createAnswer();
      return { type: a.type as "answer", sdp: a.sdp };
    },
    async setLocalDescription(desc) {
      await pc.setLocalDescription(desc as { type: "offer" | "answer"; sdp: string });
    },
    async setRemoteDescription(desc) {
      await pc.setRemoteDescription(desc as { type: "offer" | "answer"; sdp: string });
    },
    async addIceCandidate(c: IceCandidate) {
      if (!c) return;
      const cand =
        c instanceof RTCIceCandidate
          ? c
          : new RTCIceCandidate(c as Partial<RTCIceCandidate>);
      await pc.addIceCandidate(cand);
    },
    close() {
      pc.close();
    },
  };

  // werift events
  pc.onicecandidate = (ev) => {
    adapter.onicecandidate?.(ev.candidate ?? null);
  };
  pc.ondatachannel = (ev) => {
    adapter.ondatachannel?.(wrapChannel(ev.channel));
  };
  pc.iceConnectionStateChange.subscribe((s: string) => {
    adapter.oniceconnectionstatechange?.(s);
  });
  pc.connectionStateChange.subscribe((s: string) => {
    adapter.onconnectionstatechange?.(s);
  });

  return adapter;
}

function wrapChannel(ch: RTCDataChannel): DataChannel {
  const adapter: DataChannel = {
    label: ch.label,
    get readyState() {
      return ch.readyState as DataChannel["readyState"];
    },
    get bufferedAmount() {
      return ch.bufferedAmount;
    },
    set bufferedAmountLowThreshold(v: number) {
      ch.bufferedAmountLowThreshold = v;
    },
    get bufferedAmountLowThreshold() {
      return ch.bufferedAmountLowThreshold;
    },
    binaryType: "arraybuffer",
    send(data) {
      if (typeof data === "string") {
        ch.send(data);
      } else if (data instanceof ArrayBuffer) {
        ch.send(Buffer.from(data));
      } else {
        const view = data;
        ch.send(Buffer.from(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength));
      }
    },
    close() {
      ch.close();
    },
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    onbufferedamountlow: null,
  };

  ch.stateChanged.subscribe((s: string) => {
    if (s === "open") adapter.onopen?.();
    else if (s === "closed" || s === "closing") adapter.onclose?.();
  });
  ch.onMessage.subscribe((data: Buffer | string) => {
    if (typeof data === "string") {
      adapter.onmessage?.(data);
    } else {
      const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      adapter.onmessage?.(ab as ArrayBuffer);
    }
  });
  ch.bufferedAmountLow.subscribe(() => adapter.onbufferedamountlow?.());

  return adapter;
}
