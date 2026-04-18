import Foundation

// MARK: - Wire types (mirrors packages/protocol/src/signaling.ts)

struct DeviceInfo: Codable {
    let name: String
    let kind: String
    let peerId: String
    let version: Int

    enum CodingKeys: String, CodingKey {
        case name, kind, peerId = "peer_id", version
    }
}

// Client → Server
enum ClientMessage: Encodable {
    case createRoom(DeviceInfo)
    case joinRoom(code: String, device: DeviceInfo)
    case signal(to: String, data: [String: AnyCodable])
    case leaveRoom
    case ping

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: DynKey.self)
        switch self {
        case .createRoom(let device):
            try container.encode("create-room", forKey: .type)
            try container.encode(device, forKey: .device)
        case .joinRoom(let code, let device):
            try container.encode("join-room", forKey: .type)
            try container.encode(code, forKey: .code)
            try container.encode(device, forKey: .device)
        case .signal(let to, let data):
            try container.encode("signal", forKey: .type)
            try container.encode(to, forKey: .to)
            try container.encode(data, forKey: .data)
        case .leaveRoom:
            try container.encode("leave-room", forKey: .type)
        case .ping:
            try container.encode("ping", forKey: .type)
        }
    }
}

// Server → Client
struct ServerMessage: Decodable {
    let type: String
    let roomId: String?
    let code: String?
    let peerId: String?
    let device: DeviceInfo?
    let from: String?
    let data: [String: AnyCodable]?
    let error: String?
    let message: String?

    enum CodingKeys: String, CodingKey {
        case type, roomId = "room_id", code
        case peerId = "peer_id", device, from, data, error, message
    }
}

// MARK: - Signaling Client

typealias SignalHandler = (String, [String: AnyCodable]) -> Void

final class SignalingClient: NSObject, URLSessionWebSocketDelegate {
    private let url: URL
    private var socket: URLSessionWebSocketTask?
    private var session: URLSession?
    private var handlers: [SignalHandler] = []
    private var peerHandlers: [String: SignalHandler] = [:]

    var onRoomCreated: ((String, String) -> Void)?  // (roomId, code)
    var onRoomJoined: ((String, String) -> Void)?   // (roomId, peerId)
    var onPeerJoined: ((String, DeviceInfo) -> Void)?
    var onPeerLeft: ((String) -> Void)?
    var onError: ((String) -> Void)?

    init(url: URL) {
        self.url = url
        super.init()
        session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    }

    func connect() {
        socket = session?.webSocketTask(with: url)
        socket?.resume()
        receive()
    }

    func disconnect() {
        socket?.cancel(with: .normalClosure, reason: nil)
    }

    func createRoom(_ device: DeviceInfo) {
        send(.createRoom(device))
    }

    func joinRoom(code: String, device: DeviceInfo) {
        send(.joinRoom(code: code, device: device))
    }

    func signal(to peerId: String, data: [String: AnyCodable]) {
        send(.signal(to: peerId, data: data))
    }

    func leaveRoom() {
        send(.leaveRoom)
    }

    func on(_ handler: @escaping SignalHandler) {
        handlers.append(handler)
    }

    func onSignalFrom(_ peerId: String, handler: @escaping SignalHandler) {
        peerHandlers[peerId] = handler
    }

    // MARK: - Private

    private func send(_ msg: ClientMessage) {
        guard let data = try? JSONEncoder().encode(msg),
              let text = String(data: data, encoding: .utf8) else { return }
        socket?.send(.string(text)) { _ in }
    }

    private func receive() {
        socket?.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(.string(let text)):
                self.handle(text)
                self.receive()
            case .success(.data(let data)):
                if let text = String(data: data, encoding: .utf8) {
                    self.handle(text)
                }
                self.receive()
            case .failure:
                break
            @unknown default:
                self.receive()
            }
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let msg = try? JSONDecoder().decode(ServerMessage.self, from: data) else { return }

        DispatchQueue.main.async {
            switch msg.type {
            case "room-created":
                if let id = msg.roomId, let code = msg.code {
                    self.onRoomCreated?(id, code)
                }
            case "room-joined":
                if let id = msg.roomId, let pid = msg.peerId {
                    self.onRoomJoined?(id, pid)
                }
            case "peer-joined":
                if let pid = msg.peerId, let device = msg.device {
                    self.onPeerJoined?(pid, device)
                }
            case "peer-left":
                if let pid = msg.peerId {
                    self.onPeerLeft?(pid)
                }
            case "signal":
                if let from = msg.from, let signalData = msg.data {
                    self.peerHandlers[from]?(from, signalData)
                    self.handlers.forEach { $0(from, signalData) }
                }
            case "error":
                self.onError?(msg.error ?? msg.message ?? "unknown error")
            default:
                break
            }
        }
    }
}

// MARK: - URLSessionWebSocketDelegate

extension SignalingClient {
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {}
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {}
}

// MARK: - Helpers

private enum DynKey: CodingKey {
    case type, device, code, to, data
    var stringValue: String {
        switch self {
        case .type: return "type"
        case .device: return "device"
        case .code: return "code"
        case .to: return "to"
        case .data: return "data"
        }
    }
    init?(stringValue: String) { return nil }
    var intValue: Int? { nil }
    init?(intValue: Int) { return nil }
}

// Type-erased Codable for JSON signal data
struct AnyCodable: Codable {
    let value: Any

    init(_ value: Any) { self.value = value }

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let v = try? c.decode(String.self) { value = v }
        else if let v = try? c.decode(Bool.self) { value = v }
        else if let v = try? c.decode(Double.self) { value = v }
        else if let v = try? c.decode([String: AnyCodable].self) { value = v }
        else if let v = try? c.decode([AnyCodable].self) { value = v }
        else { value = NSNull() }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch value {
        case let v as String: try c.encode(v)
        case let v as Bool: try c.encode(v)
        case let v as Double: try c.encode(v)
        case let v as Int: try c.encode(v)
        case let v as [String: AnyCodable]: try c.encode(v)
        case let v as [AnyCodable]: try c.encode(v)
        default: try c.encodeNil()
        }
    }
}
