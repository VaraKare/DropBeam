package com.dropbeam

import android.content.Context
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import org.json.JSONObject
import org.webrtc.*

// Remote P2P transfer via WebRTC DataChannels.
// Mirrors JS TransferSender/Receiver frame format.

sealed class WebRTCEvent {
    data class StateChanged(val state: PeerConnection.PeerConnectionState) : WebRTCEvent()
    data class DataReceived(val data: ByteArray, val isBinary: Boolean) : WebRTCEvent()
    data class ICECandidate(val candidate: IceCandidate) : WebRTCEvent()
    data class LocalDescription(val sdp: SessionDescription) : WebRTCEvent()
    data class Error(val message: String) : WebRTCEvent()
}

class WebRTCFallback(
    context: Context,
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob()),
    val lanes: Int = 4
) {
    private val _events = MutableSharedFlow<WebRTCEvent>(extraBufferCapacity = 128)
    val events: SharedFlow<WebRTCEvent> = _events.asSharedFlow()

    private val factory: PeerConnectionFactory
    private var pc: PeerConnection? = null
    private var controlChannel: DataChannel? = null
    private val dataChannels = mutableListOf<DataChannel>()
    private val pendingICE = mutableListOf<IceCandidate>()

    init {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context)
                .setEnableInternalTracer(false)
                .createInitializationOptions()
        )
        factory = PeerConnectionFactory.builder()
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(null))
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(null, false, false))
            .createPeerConnectionFactory()
    }

    // MARK: - Setup

    fun setupAsSender(iceServers: List<PeerConnection.IceServer>) {
        pc = createPeerConnection(iceServers)
        val init = DataChannel.Init().apply { ordered = true }
        controlChannel = pc?.createDataChannel("control", init)?.also { attachChannel(it) }
        repeat(lanes) { i ->
            pc?.createDataChannel("data-$i", DataChannel.Init().apply { ordered = true })
                ?.also { attachChannel(it); dataChannels.add(it) }
        }
    }

    fun setupAsReceiver(iceServers: List<PeerConnection.IceServer>) {
        pc = createPeerConnection(iceServers)
    }

    // MARK: - Signaling

    fun createOffer() {
        pc?.createOffer(object : SdpObserver {
            override fun onCreateSuccess(sdp: SessionDescription) {
                pc?.setLocalDescription(object : SdpObserver {
                    override fun onSetSuccess() {
                        scope.launch { _events.emit(WebRTCEvent.LocalDescription(sdp)) }
                    }
                    override fun onSetFailure(s: String) = emitError("setLocal: $s")
                    override fun onCreateSuccess(p0: SessionDescription?) {}
                    override fun onCreateFailure(p0: String?) {}
                }, sdp)
            }
            override fun onCreateFailure(s: String) = emitError("createOffer: $s")
            override fun onSetSuccess() {}
            override fun onSetFailure(p0: String?) {}
        }, MediaConstraints())
    }

    fun createAnswer() {
        pc?.createAnswer(object : SdpObserver {
            override fun onCreateSuccess(sdp: SessionDescription) {
                pc?.setLocalDescription(object : SdpObserver {
                    override fun onSetSuccess() {
                        scope.launch { _events.emit(WebRTCEvent.LocalDescription(sdp)) }
                    }
                    override fun onSetFailure(s: String) = emitError("setLocal: $s")
                    override fun onCreateSuccess(p0: SessionDescription?) {}
                    override fun onCreateFailure(p0: String?) {}
                }, sdp)
            }
            override fun onCreateFailure(s: String) = emitError("createAnswer: $s")
            override fun onSetSuccess() {}
            override fun onSetFailure(p0: String?) {}
        }, MediaConstraints())
    }

    fun setRemoteDescription(sdp: SessionDescription) {
        pc?.setRemoteDescription(object : SdpObserver {
            override fun onSetSuccess() { flushPendingICE() }
            override fun onSetFailure(s: String) = emitError("setRemote: $s")
            override fun onCreateSuccess(p0: SessionDescription?) {}
            override fun onCreateFailure(p0: String?) {}
        }, sdp)
    }

    fun addIceCandidate(candidate: IceCandidate) {
        if (pc?.remoteDescription != null) pc?.addIceCandidate(candidate)
        else pendingICE.add(candidate)
    }

    fun close() { pc?.close(); pc = null }

    // MARK: - Data

    fun sendControl(text: String) {
        val buf = DataChannel.Buffer(
            java.nio.ByteBuffer.wrap(text.toByteArray()), false
        )
        controlChannel?.send(buf)
    }

    fun sendData(data: ByteArray, lane: Int) {
        if (lane >= dataChannels.size) return
        val buf = DataChannel.Buffer(java.nio.ByteBuffer.wrap(data), true)
        dataChannels[lane].send(buf)
    }

    // MARK: - Private

    private fun createPeerConnection(iceServers: List<PeerConnection.IceServer>): PeerConnection? {
        val rtcCfg = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }
        return factory.createPeerConnection(rtcCfg, object : PeerConnection.Observer {
            override fun onIceCandidate(c: IceCandidate) {
                scope.launch { _events.emit(WebRTCEvent.ICECandidate(c)) }
            }
            override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
                scope.launch { _events.emit(WebRTCEvent.StateChanged(state)) }
            }
            override fun onDataChannel(dc: DataChannel) {
                attachChannel(dc)
                if (dc.label() == "control") controlChannel = dc
                else dataChannels.add(dc)
            }
            override fun onSignalingChange(p0: PeerConnection.SignalingState?) {}
            override fun onIceConnectionChange(p0: PeerConnection.IceConnectionState?) {}
            override fun onIceConnectionReceivingChange(p0: Boolean) {}
            override fun onIceGatheringChange(p0: PeerConnection.IceGatheringState?) {}
            override fun onIceCandidatesRemoved(p0: Array<out IceCandidate>?) {}
            override fun onAddStream(p0: MediaStream?) {}
            override fun onRemoveStream(p0: MediaStream?) {}
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(p0: RtpReceiver?, p1: Array<out MediaStream>?) {}
        })
    }

    private fun attachChannel(dc: DataChannel) {
        dc.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(p0: Long) {}
            override fun onStateChange() {}
            override fun onMessage(buffer: DataChannel.Buffer) {
                val bytes = ByteArray(buffer.data.remaining())
                buffer.data.get(bytes)
                scope.launch { _events.emit(WebRTCEvent.DataReceived(bytes, buffer.binary)) }
            }
        })
    }

    private fun flushPendingICE() {
        pendingICE.forEach { pc?.addIceCandidate(it) }
        pendingICE.clear()
    }

    private fun emitError(msg: String) {
        scope.launch { _events.emit(WebRTCEvent.Error(msg)) }
    }

    companion object {
        fun defaultIceServers() = listOf(
            PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
            PeerConnection.IceServer.builder("stun:stun1.l.google.com:19302").createIceServer(),
            // Add TURN credentials here for relay fallback
        )
    }
}
