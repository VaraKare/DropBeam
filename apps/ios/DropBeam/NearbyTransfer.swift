import Foundation
import MultipeerConnectivity

// AirDrop-style LAN transfer via MultipeerConnectivity.
// Falls back to WebRTCFallback when peers are not on the same LAN segment.

private let kServiceType = "dropbeam"
private let kChunkSize = 1 << 20  // 1 MiB

protocol NearbyTransferDelegate: AnyObject {
    func nearbyTransfer(_ transfer: NearbyTransfer, didDiscover peer: MCPeerID, info: [String: String])
    func nearbyTransfer(_ transfer: NearbyTransfer, didConnect peer: MCPeerID)
    func nearbyTransfer(_ transfer: NearbyTransfer, didDisconnect peer: MCPeerID)
    func nearbyTransfer(_ transfer: NearbyTransfer, didReceiveFile name: String,
                        progress: Double, url: URL?)
    func nearbyTransfer(_ transfer: NearbyTransfer, transferFailed error: Error)
}

final class NearbyTransfer: NSObject {
    weak var delegate: NearbyTransferDelegate?

    private let myPeerID: MCPeerID
    private let session: MCSession
    private let browser: MCNearbyServiceBrowser
    private let advertiser: MCNearbyServiceAdvertiser

    private var discoveredPeers: [MCPeerID: [String: String]] = [:]
    private var activeSends: [String: Progress] = [:]

    init(displayName: String) {
        myPeerID = MCPeerID(displayName: displayName)
        session = MCSession(peer: myPeerID, securityIdentity: nil, encryptionPreference: .required)
        browser = MCNearbyServiceBrowser(peer: myPeerID, serviceType: kServiceType)
        advertiser = MCNearbyServiceAdvertiser(peer: myPeerID, discoveryInfo: ["app": "dropbeam"],
                                               serviceType: kServiceType)
        super.init()
        session.delegate = self
        browser.delegate = self
        advertiser.delegate = self
    }

    // MARK: - Lifecycle

    func start() {
        browser.startBrowsingForPeers()
        advertiser.startAdvertisingPeer()
    }

    func stop() {
        browser.stopBrowsingForPeers()
        advertiser.stopAdvertisingPeer()
        session.disconnect()
    }

    // MARK: - Send

    /// Send files to a discovered peer. Chunks through `sendData` for progress reporting.
    func sendFiles(urls: [URL], to peer: MCPeerID) {
        for url in urls {
            let progress = session.sendResource(at: url, withName: url.lastPathComponent, toPeer: peer) { error in
                if let error = error {
                    DispatchQueue.main.async { self.delegate?.nearbyTransfer(self, transferFailed: error) }
                }
            }
            if let progress = progress {
                activeSends[url.lastPathComponent] = progress
                observeProgress(progress, name: url.lastPathComponent)
            }
        }
    }

    func invite(_ peer: MCPeerID) {
        browser.invitePeer(peer, to: session, withContext: nil, timeout: 30)
    }

    // MARK: - Private

    private func observeProgress(_ progress: Progress, name: String) {
        let obs = progress.observe(\.fractionCompleted, options: .new) { [weak self] p, _ in
            guard let self = self else { return }
            DispatchQueue.main.async {
                self.delegate?.nearbyTransfer(self, didReceiveFile: name,
                                              progress: p.fractionCompleted, url: nil)
            }
        }
        // Retain observer until done
        DispatchQueue.global().async {
            while !progress.isFinished && !progress.isCancelled { Thread.sleep(forTimeInterval: 0.2) }
            obs.invalidate()
        }
    }
}

// MARK: - MCSessionDelegate

extension NearbyTransfer: MCSessionDelegate {
    func session(_ session: MCSession, peer peerID: MCPeerID,
                 didChange state: MCSessionState) {
        DispatchQueue.main.async {
            switch state {
            case .connected:
                self.delegate?.nearbyTransfer(self, didConnect: peerID)
            case .notConnected:
                self.delegate?.nearbyTransfer(self, didDisconnect: peerID)
            default: break
            }
        }
    }

    func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {}

    func session(_ session: MCSession, didReceive stream: InputStream,
                 withName streamName: String, fromPeer peerID: MCPeerID) {}

    func session(_ session: MCSession, didStartReceivingResourceWithName resourceName: String,
                 fromPeer peerID: MCPeerID, with progress: Progress) {
        DispatchQueue.main.async {
            self.delegate?.nearbyTransfer(self, didReceiveFile: resourceName, progress: 0, url: nil)
        }
        observeProgress(progress, name: resourceName)
    }

    func session(_ session: MCSession, didFinishReceivingResourceWithName resourceName: String,
                 fromPeer peerID: MCPeerID, at localURL: URL?, withError error: Error?) {
        DispatchQueue.main.async {
            if let error = error {
                self.delegate?.nearbyTransfer(self, transferFailed: error)
            } else {
                self.delegate?.nearbyTransfer(self, didReceiveFile: resourceName, progress: 1.0, url: localURL)
            }
        }
    }
}

// MARK: - MCNearbyServiceBrowserDelegate

extension NearbyTransfer: MCNearbyServiceBrowserDelegate {
    func browser(_ browser: MCNearbyServiceBrowser, foundPeer peerID: MCPeerID,
                 withDiscoveryInfo info: [String: String]?) {
        discoveredPeers[peerID] = info ?? [:]
        DispatchQueue.main.async {
            self.delegate?.nearbyTransfer(self, didDiscover: peerID, info: info ?? [:])
        }
    }

    func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) {
        discoveredPeers.removeValue(forKey: peerID)
        DispatchQueue.main.async {
            self.delegate?.nearbyTransfer(self, didDisconnect: peerID)
        }
    }

    func browser(_ browser: MCNearbyServiceBrowser, didNotStartBrowsingForPeers error: Error) {
        DispatchQueue.main.async { self.delegate?.nearbyTransfer(self, transferFailed: error) }
    }
}

// MARK: - MCNearbyServiceAdvertiserDelegate

extension NearbyTransfer: MCNearbyServiceAdvertiserDelegate {
    func advertiser(_ advertiser: MCNearbyServiceAdvertiser,
                    didReceiveInvitationFromPeer peerID: MCPeerID,
                    withContext context: Data?,
                    invitationHandler: @escaping (Bool, MCSession?) -> Void) {
        // Auto-accept; show permission UI in the host app before calling start()
        invitationHandler(true, session)
    }

    func advertiser(_ advertiser: MCNearbyServiceAdvertiser,
                    didNotStartAdvertisingPeer error: Error) {
        DispatchQueue.main.async { self.delegate?.nearbyTransfer(self, transferFailed: error) }
    }
}
