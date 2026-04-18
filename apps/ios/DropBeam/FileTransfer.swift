import Foundation
import MultipeerConnectivity

// High-level transfer coordinator.
// Route: MultipeerConnectivity (same LAN) → WebRTC (remote/fallback)

enum TransportKind { case nearby, webrtc }

struct TransferProgress {
    let fileName: String
    let bytesTransferred: Int64
    let totalBytes: Int64
    var fraction: Double { totalBytes > 0 ? Double(bytesTransferred) / Double(totalBytes) : 0 }
}

protocol FileTransferDelegate: AnyObject {
    func fileTransfer(_ ft: FileTransfer, didUpdateProgress progress: TransferProgress)
    func fileTransfer(_ ft: FileTransfer, didCompleteFile name: String, savedTo url: URL?)
    func fileTransfer(_ ft: FileTransfer, didFail error: Error)
    func fileTransfer(_ ft: FileTransfer, didDiscover peer: MCPeerID)
}

final class FileTransfer {
    weak var delegate: FileTransferDelegate?

    private let displayName: String
    private let signalingURL: URL
    private lazy var nearby = NearbyTransfer(displayName: displayName)
    private lazy var webrtc = WebRTCFallback()
    private var signaling: SignalingClient?
    private var activeTransport: TransportKind = .nearby

    init(displayName: String, signalingURL: URL) {
        self.displayName = displayName
        self.signalingURL = signalingURL
        nearby.delegate = self
    }

    // MARK: - Public API

    func startDiscovery() {
        nearby.start()
    }

    func stopDiscovery() {
        nearby.stop()
    }

    /// Send files to a nearby (same-LAN) peer.
    func sendNearby(urls: [URL], to peer: MCPeerID) {
        activeTransport = .nearby
        nearby.invite(peer)
        // sendFiles is called after connection established in delegate
        pendingURLs = urls
        pendingPeer = peer
    }

    /// Send files over WebRTC (remote peer identified by room code).
    func sendRemote(urls: [URL], roomCode: String) {
        activeTransport = .webrtc
        pendingURLs = urls
        connectSignaling(asInitiator: false, roomCode: roomCode)
    }

    /// Join as receiver (show room code to sender).
    func receiveRemote(completion: @escaping (String) -> Void) {
        activeTransport = .webrtc
        connectSignaling(asInitiator: true, roomCode: nil, onCode: completion)
    }

    // MARK: - Private

    private var pendingURLs: [URL] = []
    private var pendingPeer: MCPeerID?

    private func connectSignaling(asInitiator: Bool, roomCode: String?,
                                  onCode: ((String) -> Void)? = nil) {
        let device = DeviceInfo(name: displayName, kind: "ios",
                                peerId: UUID().uuidString, version: 1)
        let client = SignalingClient(url: signalingURL)
        signaling = client

        client.onRoomCreated = { [weak self] _, code in
            onCode?(code)
            self?.setupWebRTCAsSender()
        }
        client.onRoomJoined = { [weak self] _, _ in
            self?.setupWebRTCAsReceiver()
        }
        client.on { [weak self] from, data in
            self?.handleSignal(from: from, data: data)
        }
        client.onError = { [weak self] msg in
            self?.delegate?.fileTransfer(self!, didFail: NSError(domain: "DropBeam", code: -1,
                                                                  userInfo: [NSLocalizedDescriptionKey: msg]))
        }

        client.connect()
        if asInitiator {
            client.createRoom(device)
        } else if let code = roomCode {
            client.joinRoom(code: code, device: device)
        }
    }

    private func setupWebRTCAsSender() {
        webrtc.delegate = self
        webrtc.setupAsSender(iceServers: WebRTCFallback.defaultIceServers())
        webrtc.onICECandidate = { [weak self] candidate in
            self?.signaling?.signal(to: "broadcast", data: [
                "type": AnyCodable("ice-candidate"),
                "candidate": AnyCodable(candidate.sdp),
                "sdpMid": AnyCodable(candidate.sdpMid ?? ""),
                "sdpMLineIndex": AnyCodable(Int(candidate.sdpMLineIndex))
            ])
        }
        webrtc.createOffer { [weak self] sdp, error in
            guard let self = self, let sdp = sdp else { return }
            self.signaling?.signal(to: "broadcast", data: [
                "type": AnyCodable("offer"),
                "sdp": AnyCodable(sdp.sdp)
            ])
        }
    }

    private func setupWebRTCAsReceiver() {
        webrtc.delegate = self
        webrtc.setupAsReceiver(iceServers: WebRTCFallback.defaultIceServers())
        webrtc.onICECandidate = { [weak self] candidate in
            self?.signaling?.signal(to: "broadcast", data: [
                "type": AnyCodable("ice-candidate"),
                "candidate": AnyCodable(candidate.sdp),
                "sdpMid": AnyCodable(candidate.sdpMid ?? ""),
                "sdpMLineIndex": AnyCodable(Int(candidate.sdpMLineIndex))
            ])
        }
    }

    private func handleSignal(from: String, data: [String: AnyCodable]) {
        guard let type = data["type"]?.value as? String else { return }
        switch type {
        case "offer":
            guard let sdpStr = data["sdp"]?.value as? String else { return }
            let sdp = RTCSessionDescription(type: .offer, sdp: sdpStr)
            webrtc.setRemoteDescription(sdp) { [weak self] _ in
                self?.webrtc.createAnswer { answer, _ in
                    guard let self = self, let answer = answer else { return }
                    self.signaling?.signal(to: from, data: [
                        "type": AnyCodable("answer"),
                        "sdp": AnyCodable(answer.sdp)
                    ])
                }
            }
        case "answer":
            guard let sdpStr = data["sdp"]?.value as? String else { return }
            let sdp = RTCSessionDescription(type: .answer, sdp: sdpStr)
            webrtc.setRemoteDescription(sdp) { _ in }
        case "ice-candidate":
            guard let candidateStr = data["candidate"]?.value as? String,
                  let mid = data["sdpMid"]?.value as? String,
                  let lineIndex = data["sdpMLineIndex"]?.value as? Int else { return }
            let candidate = RTCIceCandidate(sdp: candidateStr, sdpMLineIndex: Int32(lineIndex), sdpMid: mid)
            webrtc.addIceCandidate(candidate)
        default:
            break
        }
    }
}

// MARK: - NearbyTransferDelegate

extension FileTransfer: NearbyTransferDelegate {
    func nearbyTransfer(_ transfer: NearbyTransfer, didDiscover peer: MCPeerID,
                        info: [String: String]) {
        delegate?.fileTransfer(self, didDiscover: peer)
    }

    func nearbyTransfer(_ transfer: NearbyTransfer, didConnect peer: MCPeerID) {
        if let urls = Optional(pendingURLs), !urls.isEmpty, peer == pendingPeer {
            nearby.sendFiles(urls: urls, to: peer)
            pendingURLs = []
        }
    }

    func nearbyTransfer(_ transfer: NearbyTransfer, didDisconnect peer: MCPeerID) {}

    func nearbyTransfer(_ transfer: NearbyTransfer, didReceiveFile name: String,
                        progress: Double, url: URL?) {
        let p = TransferProgress(fileName: name, bytesTransferred: Int64(progress * 1e9),
                                 totalBytes: Int64(1e9))
        delegate?.fileTransfer(self, didUpdateProgress: p)
        if progress >= 1.0, let url = url {
            delegate?.fileTransfer(self, didCompleteFile: name, savedTo: url)
        }
    }

    func nearbyTransfer(_ transfer: NearbyTransfer, transferFailed error: Error) {
        delegate?.fileTransfer(self, didFail: error)
    }
}

// MARK: - WebRTCFallbackDelegate

extension FileTransfer: WebRTCFallbackDelegate {
    func webRTC(_ rtc: WebRTCFallback, didChangeState state: RTCPeerConnectionState) {
        if state == .connected && !pendingURLs.isEmpty {
            // Sender: begin streaming manifest + chunks via control/data channels
            // Full frame encoding mirrors TransferSender in packages/transfer
            startWebRTCSend()
        }
    }

    func webRTC(_ rtc: WebRTCFallback, didReceiveData data: Data) {
        // Decode frame header (16 bytes) + payload — same format as TS receiver
        processDataFrame(data)
    }

    func webRTC(_ rtc: WebRTCFallback, didReceiveControl text: String) {
        processControlMessage(text)
    }

    private func startWebRTCSend() {
        let urls = pendingURLs
        pendingURLs = []
        let manifest: [[String: Any]] = urls.map { url in
            let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int64) ?? 0
            return ["name": url.lastPathComponent, "size": size, "id": UUID().uuidString]
        }
        if let data = try? JSONSerialization.data(withJSONObject: ["type": "manifest", "files": manifest]),
           let text = String(data: data, encoding: .utf8) {
            webrtc.sendControl(text)
        }
        for (fileIdx, url) in urls.enumerated() {
            streamFile(url: url, fileId: UInt32(fileIdx))
        }
        webrtc.sendControl("{\"type\":\"complete\"}")
    }

    private func streamFile(url: URL, fileId: UInt32) {
        guard let fh = FileHandle(forReadingAtPath: url.path) else { return }
        defer { fh.closeFile() }
        var chunkIndex: UInt32 = 0
        let chunkSize = 256 * 1024
        while true {
            let data = fh.readData(ofLength: chunkSize)
            if data.isEmpty { break }
            var header = Data(count: 16)
            header[0] = 0xDB  // magic
            header[1] = 1     // version
            header[2] = 0     // flags
            header[3] = 0     // reserved
            header.withUnsafeMutableBytes { ptr in
                ptr.storeBytes(of: fileId.bigEndian, toByteOffset: 4, as: UInt32.self)
                ptr.storeBytes(of: chunkIndex.bigEndian, toByteOffset: 8, as: UInt32.self)
                ptr.storeBytes(of: UInt32(data.count).bigEndian, toByteOffset: 12, as: UInt32.self)
            }
            let frame = header + data
            webrtc.sendData(frame, lane: Int(chunkIndex) % webrtc.lanes)
            chunkIndex += 1
        }
    }

    private func processDataFrame(_ data: Data) {
        guard data.count >= 16 else { return }
        // Minimal receive — host app handles reassembly
        delegate?.fileTransfer(self, didUpdateProgress:
            TransferProgress(fileName: "incoming", bytesTransferred: Int64(data.count), totalBytes: -1))
    }

    private func processControlMessage(_ text: String) {
        guard let json = try? JSONSerialization.jsonObject(with: text.data(using: .utf8)!) as? [String: Any],
              let type = json["type"] as? String else { return }
        if type == "complete" {
            delegate?.fileTransfer(self, didCompleteFile: "transfer", savedTo: nil)
        }
    }
}

// WebRTC import placeholder — resolved by CocoaPods/SPM GoogleWebRTC
import class WebRTC.RTCSessionDescription
import class WebRTC.RTCIceCandidate
