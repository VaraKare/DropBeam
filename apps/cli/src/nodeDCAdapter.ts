/**
 * node-datachannel → DropBeam PeerConnection adapter.
 *
 * node-datachannel (libdatachannel C++ binding) has a callback-based API
 * that differs from the browser / werift async model. This file bridges
 * the gap so the transfer engine never knows which stack it's running on.
 *
 * Key differences vs werift:
 *  - No async createOffer/createAnswer — gathering is triggered by
 *    setLocalDescription(); the result fires via onLocalDescription().
 *  - addRemoteCandidate(candidate: string, mid: string) — flat strings.
 *  - DataChannel methods are functions, not properties (bufferedAmount(),
 *    getLabel(), isOpen(), …).
 */

import nodedc, { type RtcConfig, type DataChannel as NDCDataChannel, type DataChannelInitConfig } from "node-datachannel";
import type {
  DataChannel,
  IceCandidate,
  PeerConnection,
  SessionDescription,
} from "@dropbeam/transfer";

export interface NodeDCOptions {
  iceServers?: { urls: string | string[]; username?: string; credential?: string }[];
  /** Port range for ICE candidates. */
  portRangeBegin?: number;
  portRangeEnd?: number;
}

export function makeNodeDCPeer(opts: NodeDCOptions = {}): PeerConnection {
  const iceServers = opts.iceServers ?? [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];

  // node-datachannel accepts plain "stun:host:port" strings directly
  const ndcIceServers: string[] = iceServers.flatMap((s) =>
    Array.isArray(s.urls) ? s.urls : [s.urls],
  );

  const ndc = new nodedc.PeerConnection("dropbeam", {
    iceServers: ndcIceServers,
    iceTransportPolicy: "all",
    portRangeBegin: opts.portRangeBegin,
    portRangeEnd: opts.portRangeEnd,
  } as RtcConfig);

  let pendingDescResolve: ((d: SessionDescription) => void) | null = null;

  const adapter: PeerConnection = {
    onicecandidate: null,
    ondatachannel: null,
    oniceconnectionstatechange: null,
    onconnectionstatechange: null,

    createDataChannel(label, init) {
      const dcInit: DataChannelInitConfig = {
        unordered: !(init?.ordered ?? true),
        maxRetransmits: init?.maxRetransmits,
      };
      const ch = ndc.createDataChannel(label, dcInit);
      return wrapChannel(ch);
    },

    createOffer() {
      return new Promise<SessionDescription>((res) => {
        pendingDescResolve = res;
        ndc.setLocalDescription("offer");
      });
    },

    createAnswer() {
      return new Promise<SessionDescription>((res) => {
        pendingDescResolve = res;
        ndc.setLocalDescription("answer");
      });
    },

    // no-op: node-datachannel handles setLocalDescription internally inside
    // createOffer/createAnswer above.
    async setLocalDescription(_desc) {},

    async setRemoteDescription(desc) {
      ndc.setRemoteDescription(desc.sdp ?? "", desc.type as "offer" | "answer");
    },

    async addIceCandidate(c: IceCandidate) {
      if (!c || typeof c !== "object") return;
      const { candidate, sdpMid } = c as { candidate: string; sdpMid?: string };
      if (!candidate) return;
      ndc.addRemoteCandidate(candidate, sdpMid ?? "0");
    },

    close() {
      try {
        ndc.close();
      } catch {}
    },
  };

  ndc.onLocalDescription((sdp, type) => {
    pendingDescResolve?.({ type: type as "offer" | "answer", sdp });
    pendingDescResolve = null;
  });

  ndc.onLocalCandidate((candidate, mid) => {
    adapter.onicecandidate?.({ candidate, sdpMid: mid, sdpMLineIndex: 0 });
  });

  ndc.onDataChannel((ch) => {
    adapter.ondatachannel?.(wrapChannel(ch));
  });

  ndc.onStateChange((state) => {
    adapter.onconnectionstatechange?.(state);
  });

  ndc.onIceStateChange((state) => {
    adapter.oniceconnectionstatechange?.(state);
  });

  return adapter;
}

function wrapChannel(ch: NDCDataChannel): DataChannel {
  let threshold = 0;

  const adapter: DataChannel = {
    get label() {
      return ch.getLabel();
    },
    get readyState(): DataChannel["readyState"] {
      if (ch.isOpen()) return "open";
      try {
        return "closed";
      } catch {
        return "closed";
      }
    },
    get bufferedAmount() {
      return ch.bufferedAmount();
    },
    get bufferedAmountLowThreshold() {
      return threshold;
    },
    set bufferedAmountLowThreshold(v: number) {
      threshold = v;
      ch.setBufferedAmountLowThreshold(v);
    },
    binaryType: "arraybuffer",

    send(data) {
      if (typeof data === "string") {
        ch.sendMessage(data);
      } else if (data instanceof ArrayBuffer) {
        ch.sendMessageBinary(Buffer.from(data));
      } else {
        const v = data as ArrayBufferView;
        ch.sendMessageBinary(
          Buffer.from(v.buffer as ArrayBuffer, v.byteOffset, v.byteLength),
        );
      }
    },
    close() {
      try {
        ch.close();
      } catch {}
    },

    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    onbufferedamountlow: null,
  };

  ch.onOpen(() => adapter.onopen?.());
  ch.onClosed(() => adapter.onclose?.());
  ch.onError((err: string) => adapter.onerror?.(new Error(err)));
  ch.onMessage((msg: string | Buffer | ArrayBuffer) => {
    if (typeof msg === "string") {
      adapter.onmessage?.(msg);
    } else {
      // Buffer from native — copy into a plain ArrayBuffer
      const buf = msg as Buffer;
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      adapter.onmessage?.(ab as ArrayBuffer);
    }
  });
  ch.onBufferedAmountLow(() => adapter.onbufferedamountlow?.());

  return adapter;
}
