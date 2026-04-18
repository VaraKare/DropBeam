package com.dropbeam

import kotlinx.coroutines.*
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.*
import okhttp3.*
import org.json.JSONObject

// Wire types mirror packages/protocol/src/signaling.ts

data class DeviceInfo(
    val name: String,
    val kind: String,
    val peerId: String,
    val version: Int = 1
)

sealed class ServerEvent {
    data class RoomCreated(val roomId: String, val code: String) : ServerEvent()
    data class RoomJoined(val roomId: String, val peerId: String) : ServerEvent()
    data class PeerJoined(val peerId: String, val device: DeviceInfo) : ServerEvent()
    data class PeerLeft(val peerId: String) : ServerEvent()
    data class Signal(val from: String, val data: JSONObject) : ServerEvent()
    data class Error(val message: String) : ServerEvent()
}

class SignalingClient(
    private val url: String,
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
) {
    private val client = OkHttpClient()
    private var ws: WebSocket? = null

    private val _events = MutableSharedFlow<ServerEvent>(extraBufferCapacity = 64)
    val events: SharedFlow<ServerEvent> = _events.asSharedFlow()

    fun connect() {
        val request = Request.Builder().url(url).build()
        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                scope.launch { handleMessage(text) }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                scope.launch { _events.emit(ServerEvent.Error(t.message ?: "connection error")) }
            }
        })
    }

    fun disconnect() { ws?.close(1000, null) }

    fun createRoom(device: DeviceInfo) = send(JSONObject().apply {
        put("type", "create-room")
        put("device", device.toJson())
    })

    fun joinRoom(code: String, device: DeviceInfo) = send(JSONObject().apply {
        put("type", "join-room")
        put("code", code)
        put("device", device.toJson())
    })

    fun signal(to: String, data: JSONObject) = send(JSONObject().apply {
        put("type", "signal")
        put("to", to)
        put("data", data)
    })

    fun leaveRoom() = send(JSONObject().put("type", "leave-room"))

    private fun send(json: JSONObject) { ws?.send(json.toString()) }

    private suspend fun handleMessage(text: String) {
        val json = runCatching { JSONObject(text) }.getOrNull() ?: return
        val event = when (json.optString("type")) {
            "room-created" -> ServerEvent.RoomCreated(
                json.getString("room_id"), json.getString("code")
            )
            "room-joined" -> ServerEvent.RoomJoined(
                json.getString("room_id"), json.getString("peer_id")
            )
            "peer-joined" -> ServerEvent.PeerJoined(
                json.getString("peer_id"), json.getJSONObject("device").toDevice()
            )
            "peer-left" -> ServerEvent.PeerLeft(json.getString("peer_id"))
            "signal" -> ServerEvent.Signal(
                json.getString("from"), json.getJSONObject("data")
            )
            "error" -> ServerEvent.Error(json.optString("error", json.optString("message", "unknown")))
            else -> return
        }
        _events.emit(event)
    }
}

private fun DeviceInfo.toJson() = JSONObject().apply {
    put("name", name); put("kind", kind)
    put("peer_id", peerId); put("version", version)
}

private fun JSONObject.toDevice() = DeviceInfo(
    name = getString("name"),
    kind = getString("kind"),
    peerId = getString("peer_id"),
    version = optInt("version", 1)
)
