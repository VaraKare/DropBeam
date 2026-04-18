/**
 * One-shot SDP/ICE handshake between two peers via the signaling server.
 * The "offerer" creates datachannels first, then offer; the "answerer"
 * waits for the offer, attaches ondatachannel, then answers.
 */

import type { PeerConnection } from "@dropbeam/transfer";
import type { SignalingClient } from "@dropbeam/transfer";

interface OfferEnvelope {
  kind: "offer";
  sdp: { type: "offer"; sdp: string };
}
interface AnswerEnvelope {
  kind: "answer";
  sdp: { type: "answer"; sdp: string };
}
interface IceEnvelope {
  kind: "ice";
  candidate: unknown;
}
type Envelope = OfferEnvelope | AnswerEnvelope | IceEnvelope;

export async function offer(
  pc: PeerConnection,
  signaling: SignalingClient,
  remotePeerId: string,
): Promise<void> {
  pc.onicecandidate = (c) => {
    if (c) signaling.signal(remotePeerId, { kind: "ice", candidate: c } satisfies IceEnvelope);
  };
  signaling.onSignalFrom(remotePeerId, async (raw) => {
    const env = raw as Envelope;
    if (env.kind === "answer") {
      await pc.setRemoteDescription(env.sdp);
    } else if (env.kind === "ice") {
      try {
        await pc.addIceCandidate(env.candidate);
      } catch {}
    }
  });
  const sdp = await pc.createOffer();
  await pc.setLocalDescription(sdp);
  signaling.signal(remotePeerId, { kind: "offer", sdp: sdp as OfferEnvelope["sdp"] });
}

export async function answer(
  pc: PeerConnection,
  signaling: SignalingClient,
  remotePeerId: string,
): Promise<void> {
  let answered = false;
  pc.onicecandidate = (c) => {
    if (c) signaling.signal(remotePeerId, { kind: "ice", candidate: c } satisfies IceEnvelope);
  };
  signaling.onSignalFrom(remotePeerId, async (raw) => {
    const env = raw as Envelope;
    if (env.kind === "offer" && !answered) {
      answered = true;
      await pc.setRemoteDescription(env.sdp);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      signaling.signal(remotePeerId, { kind: "answer", sdp: ans as AnswerEnvelope["sdp"] });
    } else if (env.kind === "ice") {
      try {
        await pc.addIceCandidate(env.candidate);
      } catch {}
    }
  });
}
