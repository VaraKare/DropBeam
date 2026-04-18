package com.dropbeam

import android.content.Context
import android.net.wifi.p2p.WifiP2pDevice
import android.net.wifi.p2p.WifiP2pInfo
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.IceCandidate
import org.webrtc.PeerConnection
import org.webrtc.SessionDescription
import java.io.File
import java.util.UUID

// High-level transfer coordinator.
// Route: WiFi Direct (same LAN) → WebRTC (remote/fallback)

enum class TransportKind { NEARBY, WEBRTC }

sealed class TransferEvent {
    data class Discovered(val device: WifiP2pDevice) : TransferEvent()
    data class Progress(val name: String, val bytes: Long, val total: Long) : TransferEvent()
    data class Complete(val name: String, val file: File?) : TransferEvent()
    data class Error(val error: Throwable) : TransferEvent()
    data class RoomCode(val code: String) : TransferEvent()
}

class FileTransfer(
    private val context: Context,
    private val signalingUrl: String,
    private val displayName: String,
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
) {
    private val _events = MutableSharedFlow<TransferEvent>(extraBufferCapacity = 64)
    val events: SharedFlow<TransferEvent> = _events.asSharedFlow()

    private val nearby = NearbyTransfer(context, scope)
    private val webrtc by lazy { WebRTCFallback(context, scope) }
    private var signaling: SignalingClient? = null

    private var pendingFiles: List<File> = emptyList()
    private var remotePeerId: String? = null
    private var peerId = UUID.randomUUID().toString()

    init {
        scope.launch { nearby.events.collect { handleNearbyEvent(it) } }
    }

    // MARK: - Public API

    fun startDiscovery() = nearby.start()
    fun stopDiscovery() = nearby.stop()

    fun connectNearby(device: WifiP2pDevice) = nearby.connect(device)

    fun sendNearby(files: List<File>, info: WifiP2pInfo) {
        pendingFiles = files
        if (info.isGroupOwner) {
            // We are the GO — start a server socket and wait for peer
            // (peer will connect to us; we send after their connection)
        } else {
            nearby.sendFiles(files, info.groupOwnerAddress.hostAddress ?: return)
        }
    }

    fun sendRemote(files: List<File>, roomCode: String) {
        pendingFiles = files
        connectSignaling { client ->
            client.joinRoom(code = roomCode, device = myDevice())
        }
    }

    fun receiveRemote() {
        connectSignaling { client ->
            client.createRoom(myDevice())
        }
    }

    fun close() {
        stopDiscovery()
        webrtc.close()
        signaling?.disconnect()
        scope.cancel()
    }

    // MARK: - Private

    private fun myDevice() = DeviceInfo(
        name = displayName, kind = "android", peerId = peerId
    )

    private fun connectSignaling(setup: (SignalingClient) -> Unit) {
        val client = SignalingClient(signalingUrl, scope)
        signaling = client

        scope.launch {
            client.events.collect { event ->
                when (event) {
                    is ServerEvent.RoomCreated -> {
                        _events.emit(TransferEvent.RoomCode(event.code))
                        setupWebRTCAsReceiver()
                    }
                    is ServerEvent.RoomJoined -> {
                        remotePeerId = event.peerId
                        setupWebRTCAsSender()
                    }
                    is ServerEvent.PeerJoined -> {
                        remotePeerId = event.peerId
                        setupWebRTCAsSender()
                    }
                    is ServerEvent.Signal -> handleSignal(event.from, event.data)
                    is ServerEvent.Error -> _events.emit(TransferEvent.Error(Exception(event.message)))
                    else -> {}
                }
            }
        }

        client.connect()
        setup(client)
    }

    private fun setupWebRTCAsSender() {
        scope.launch { webrtc.events.collect { handleWebRTCEvent(it) } }
        webrtc.setupAsSender(WebRTCFallback.defaultIceServers())
        webrtc.createOffer()
    }

    private fun setupWebRTCAsReceiver() {
        scope.launch { webrtc.events.collect { handleWebRTCEvent(it) } }
        webrtc.setupAsReceiver(WebRTCFallback.defaultIceServers())
    }

    private fun handleWebRTCEvent(event: WebRTCEvent) {
        when (event) {
            is WebRTCEvent.ICECandidate -> {
                val target = remotePeerId ?: return
                signaling?.signal(target, JSONObject().apply {
                    put("type", "ice-candidate")
                    put("candidate", event.candidate.sdp)
                    put("sdpMid", event.candidate.sdpMid)
                    put("sdpMLineIndex", event.candidate.sdpMLineIndex)
                })
            }
            is WebRTCEvent.LocalDescription -> {
                val target = remotePeerId ?: return
                signaling?.signal(target, JSONObject().apply {
                    put("type", if (event.sdp.type == SessionDescription.Type.OFFER) "offer" else "answer")
                    put("sdp", event.sdp.description)
                })
            }
            is WebRTCEvent.StateChanged -> {
                if (event.state == PeerConnection.PeerConnectionState.CONNECTED) {
                    scope.launch { startWebRTCSend() }
                }
            }
            is WebRTCEvent.DataReceived -> {
                if (event.isBinary) {
                    scope.launch { _events.emit(TransferEvent.Progress("incoming", event.data.size.toLong(), -1)) }
                } else {
                    processControlMessage(String(event.data))
                }
            }
            is WebRTCEvent.Error -> scope.launch {
                _events.emit(TransferEvent.Error(Exception(event.message)))
            }
        }
    }

    private fun handleSignal(from: String, data: JSONObject) {
        when (data.optString("type")) {
            "offer" -> {
                remotePeerId = from
                val sdp = SessionDescription(SessionDescription.Type.OFFER, data.getString("sdp"))
                webrtc.setRemoteDescription(sdp)
                webrtc.createAnswer()
            }
            "answer" -> {
                val sdp = SessionDescription(SessionDescription.Type.ANSWER, data.getString("sdp"))
                webrtc.setRemoteDescription(sdp)
            }
            "ice-candidate" -> {
                val candidate = IceCandidate(
                    data.getString("sdpMid"),
                    data.getInt("sdpMLineIndex"),
                    data.getString("candidate")
                )
                webrtc.addIceCandidate(candidate)
            }
        }
    }

    private suspend fun startWebRTCSend() {
        val files = pendingFiles
        if (files.isEmpty()) return
        pendingFiles = emptyList()

        val manifestArr = JSONArray()
        files.forEach { f ->
            manifestArr.put(JSONObject().apply {
                put("name", f.name); put("size", f.length()); put("id", UUID.randomUUID().toString())
            })
        }
        webrtc.sendControl(JSONObject().apply {
            put("type", "manifest"); put("files", manifestArr)
        }.toString())

        files.forEachIndexed { fileIdx, file ->
            streamFileWebRTC(file, fileIdx)
        }
        webrtc.sendControl("""{"type":"complete"}""")
    }

    private suspend fun streamFileWebRTC(file: File, fileId: Int) {
        val chunkSize = 256 * 1024
        file.inputStream().use { fis ->
            var chunkIndex = 0
            val buf = ByteArray(chunkSize)
            var n: Int
            while (fis.read(buf).also { n = it } != -1) {
                val payload = buf.copyOf(n)
                val frame = ByteArray(16 + n)
                frame[0] = 0xDB.toByte()
                frame[1] = 1
                frame[2] = 0
                frame[3] = 0
                writeInt32BE(frame, 4, fileId)
                writeInt32BE(frame, 8, chunkIndex)
                writeInt32BE(frame, 12, n)
                payload.copyInto(frame, 16)
                webrtc.sendData(frame, chunkIndex % webrtc.lanes)
                _events.emit(TransferEvent.Progress(file.name, (chunkIndex.toLong() + 1) * chunkSize, file.length()))
                chunkIndex++
            }
        }
    }

    private fun processControlMessage(text: String) {
        val json = runCatching { JSONObject(text) }.getOrNull() ?: return
        when (json.optString("type")) {
            "manifest" -> { /* host app can display file list */ }
            "complete" -> scope.launch { _events.emit(TransferEvent.Complete("transfer", null)) }
        }
    }

    private suspend fun handleNearbyEvent(event: NearbyEvent) {
        when (event) {
            is NearbyEvent.PeersDiscovered -> event.peers.forEach {
                _events.emit(TransferEvent.Discovered(it))
            }
            is NearbyEvent.ReceiveProgress -> _events.emit(
                TransferEvent.Progress(event.name, event.bytes, event.total)
            )
            is NearbyEvent.ReceiveComplete -> _events.emit(
                TransferEvent.Complete(event.name, event.file)
            )
            is NearbyEvent.TransferError -> _events.emit(TransferEvent.Error(event.error))
            else -> {}
        }
    }

    private fun writeInt32BE(buf: ByteArray, offset: Int, value: Int) {
        buf[offset] = (value shr 24).toByte()
        buf[offset + 1] = (value shr 16).toByte()
        buf[offset + 2] = (value shr 8).toByte()
        buf[offset + 3] = value.toByte()
    }
}
