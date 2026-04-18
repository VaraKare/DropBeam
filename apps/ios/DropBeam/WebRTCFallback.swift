import Foundation
import WebRTC  // GoogleWebRTC pod

// Remote P2P transfer via WebRTC DataChannels.
// Used when MultipeerConnectivity is unavailable (different networks).
// Mirrors the JS TransferSender/Receiver frame format exactly.

private let kChunkSize = 256 << 10  // 256 KiB per chunk

protocol WebRTCFallbackDelegate: AnyObject {
    func webRTC(_ rtc: WebRTCFallback, didChangeState state: RTCPeerConnectionState)
    func webRTC(_ rtc: WebRTCFallback, didReceiveData data: Data)
    func webRTC(_ rtc: WebRTCFallback, didReceiveControl text: String)
}

final class WebRTCFallback: NSObject {
    weak var delegate: WebRTCFallbackDelegate?

    private let factory: RTCPeerConnectionFactory
    private var pc: RTCPeerConnection?
    private var controlChannel: RTCDataChannel?
    private var dataChannels: [RTCDataChannel] = []
    private var pendingICE: [RTCIceCandidate] = []

    var onICECandidate: ((RTCIceCandidate) -> Void)?
    var lanes: Int = 4

    override init() {
        RTCInitializeSSL()
        let enc = RTCDefaultVideoEncoderFactory()
        let dec = RTCDefaultVideoDecoderFactory()
        factory = RTCPeerConnectionFactory(encoderFactory: enc, decoderFactory: dec)
        super.init()
    }

    // MARK: - Setup

    func setupAsSender(iceServers: [RTCIceServer]) {
        pc = makePeerConnection(iceServers: iceServers)
        let cfg = RTCDataChannelConfiguration()
        cfg.isOrdered = true
        cfg.isNegotiated = false
        controlChannel = pc?.dataChannel(forLabel: "control", configuration: cfg)
        controlChannel?.delegate = self

        for i in 0..<lanes {
            let dcfg = RTCDataChannelConfiguration()
            dcfg.isOrdered = true
            if let ch = pc?.dataChannel(forLabel: "data-\(i)", configuration: dcfg) {
                ch.delegate = self
                dataChannels.append(ch)
            }
        }
    }

    func setupAsReceiver(iceServers: [RTCIceServer]) {
        pc = makePeerConnection(iceServers: iceServers)
    }

    // MARK: - Signaling

    func createOffer(completion: @escaping (RTCSessionDescription?, Error?) -> Void) {
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        pc?.offer(for: constraints) { [weak self] sdp, error in
            guard let self = self, let sdp = sdp else { completion(nil, error); return }
            self.pc?.setLocalDescription(sdp) { err in
                completion(err == nil ? sdp : nil, err)
            }
        }
    }

    func createAnswer(completion: @escaping (RTCSessionDescription?, Error?) -> Void) {
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        pc?.answer(for: constraints) { [weak self] sdp, error in
            guard let self = self, let sdp = sdp else { completion(nil, error); return }
            self.pc?.setLocalDescription(sdp) { err in
                completion(err == nil ? sdp : nil, err)
            }
        }
    }

    func setRemoteDescription(_ sdp: RTCSessionDescription, completion: @escaping (Error?) -> Void) {
        pc?.setRemoteDescription(sdp) { [weak self] error in
            if error == nil { self?.flushPendingICE() }
            completion(error)
        }
    }

    func addIceCandidate(_ candidate: RTCIceCandidate) {
        if pc?.remoteDescription != nil {
            pc?.add(candidate)
        } else {
            pendingICE.append(candidate)
        }
    }

    func close() {
        pc?.close()
        pc = nil
    }

    // MARK: - Data

    func sendControl(_ text: String) {
        guard let data = text.data(using: .utf8) else { return }
        controlChannel?.sendData(RTCDataBuffer(data: data, isBinary: false))
    }

    func sendData(_ data: Data, lane: Int) {
        guard lane < dataChannels.count else { return }
        dataChannels[lane].sendData(RTCDataBuffer(data: data, isBinary: true))
    }

    // MARK: - Private

    private func makePeerConnection(iceServers: [RTCIceServer]) -> RTCPeerConnection? {
        let cfg = RTCConfiguration()
        cfg.iceServers = iceServers
        cfg.sdpSemantics = .unifiedPlan
        cfg.continualGatheringPolicy = .gatherContinually
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        return factory.peerConnection(with: cfg, constraints: constraints, delegate: self)
    }

    private func flushPendingICE() {
        pendingICE.forEach { pc?.add($0) }
        pendingICE.removeAll()
    }
}

// MARK: - RTCPeerConnectionDelegate

extension WebRTCFallback: RTCPeerConnectionDelegate {
    func peerConnection(_ pc: RTCPeerConnection, didChange state: RTCPeerConnectionState) {
        DispatchQueue.main.async { self.delegate?.webRTC(self, didChangeState: state) }
    }

    func peerConnection(_ pc: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        onICECandidate?(candidate)
    }

    func peerConnection(_ pc: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        dataChannel.delegate = self
        if dataChannel.label == "control" {
            controlChannel = dataChannel
        } else {
            dataChannels.append(dataChannel)
        }
    }

    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
}

// MARK: - RTCDataChannelDelegate

extension WebRTCFallback: RTCDataChannelDelegate {
    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {}

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        if buffer.isBinary {
            DispatchQueue.main.async { self.delegate?.webRTC(self, didReceiveData: buffer.data) }
        } else if let text = String(data: buffer.data, encoding: .utf8) {
            DispatchQueue.main.async { self.delegate?.webRTC(self, didReceiveControl: text) }
        }
    }
}

// MARK: - ICE server helpers

extension WebRTCFallback {
    static func defaultIceServers() -> [RTCIceServer] {
        [
            RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"]),
            RTCIceServer(urlStrings: ["stun:stun1.l.google.com:19302"]),
            // Add TURN credentials here for relay fallback
        ]
    }
}
