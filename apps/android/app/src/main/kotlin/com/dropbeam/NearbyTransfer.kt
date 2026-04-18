package com.dropbeam

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.wifi.p2p.*
import android.net.wifi.p2p.WifiP2pManager.*
import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import java.io.*
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket

// WiFi Direct (WifiP2pManager) for same-LAN peer discovery and transfer.
// Falls back to WebRTCFallback when WiFi Direct group formation fails.

private const val TAG = "NearbyTransfer"
private const val SERVER_PORT = 8988
private const val CHUNK_SIZE = 1 shl 20  // 1 MiB

sealed class NearbyEvent {
    data class PeersDiscovered(val peers: List<WifiP2pDevice>) : NearbyEvent()
    data class Connected(val info: WifiP2pInfo) : NearbyEvent()
    object Disconnected : NearbyEvent()
    data class ReceiveProgress(val name: String, val bytes: Long, val total: Long) : NearbyEvent()
    data class ReceiveComplete(val name: String, val file: File) : NearbyEvent()
    data class TransferError(val error: Throwable) : NearbyEvent()
}

class NearbyTransfer(
    private val context: Context,
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
) {
    private val manager: WifiP2pManager =
        context.getSystemService(Context.WIFI_P2P_SERVICE) as WifiP2pManager
    private val channel: Channel = manager.initialize(context, context.mainLooper, null)

    private val _events = MutableSharedFlow<NearbyEvent>(extraBufferCapacity = 64)
    val events: SharedFlow<NearbyEvent> = _events.asSharedFlow()

    private var serverJob: Job? = null

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            when (intent.action) {
                WIFI_P2P_PEERS_CHANGED_ACTION -> {
                    manager.requestPeers(channel) { list ->
                        scope.launch { _events.emit(NearbyEvent.PeersDiscovered(list.deviceList.toList())) }
                    }
                }
                WIFI_P2P_CONNECTION_CHANGED_ACTION -> {
                    manager.requestConnectionInfo(channel) { info ->
                        if (info.groupFormed) {
                            scope.launch { _events.emit(NearbyEvent.Connected(info)) }
                        } else {
                            scope.launch { _events.emit(NearbyEvent.Disconnected) }
                        }
                    }
                }
            }
        }
    }

    fun start() {
        val filter = IntentFilter().apply {
            addAction(WIFI_P2P_PEERS_CHANGED_ACTION)
            addAction(WIFI_P2P_CONNECTION_CHANGED_ACTION)
        }
        context.registerReceiver(receiver, filter)
        discoverPeers()
        startReceiveServer()
    }

    fun stop() {
        runCatching { context.unregisterReceiver(receiver) }
        serverJob?.cancel()
        manager.removeGroup(channel, null)
    }

    fun discoverPeers() {
        manager.discoverPeers(channel, object : ActionListener {
            override fun onSuccess() { Log.d(TAG, "discovery started") }
            override fun onFailure(reason: Int) {
                scope.launch { _events.emit(NearbyEvent.TransferError(Exception("discovery failed: $reason"))) }
            }
        })
    }

    fun connect(device: WifiP2pDevice) {
        val config = WifiP2pConfig().apply { deviceAddress = device.deviceAddress }
        manager.connect(channel, config, object : ActionListener {
            override fun onSuccess() {}
            override fun onFailure(reason: Int) {
                scope.launch { _events.emit(NearbyEvent.TransferError(Exception("connect failed: $reason"))) }
            }
        })
    }

    fun sendFiles(files: List<File>, groupOwnerAddress: String) {
        scope.launch {
            try {
                Socket().use { socket ->
                    socket.connect(InetSocketAddress(groupOwnerAddress, SERVER_PORT), 5000)
                    val out = DataOutputStream(socket.getOutputStream())
                    out.writeInt(files.size)
                    for (file in files) {
                        out.writeUTF(file.name)
                        out.writeLong(file.length())
                        FileInputStream(file).use { fis ->
                            val buf = ByteArray(CHUNK_SIZE)
                            var sent = 0L
                            var n: Int
                            while (fis.read(buf).also { n = it } != -1) {
                                out.write(buf, 0, n)
                                sent += n
                                _events.emit(NearbyEvent.ReceiveProgress(file.name, sent, file.length()))
                            }
                        }
                    }
                    out.flush()
                }
            } catch (e: Throwable) {
                _events.emit(NearbyEvent.TransferError(e))
            }
        }
    }

    private fun startReceiveServer() {
        serverJob = scope.launch {
            try {
                ServerSocket(SERVER_PORT).use { server ->
                    while (isActive) {
                        val client = server.accept()
                        launch { receiveFiles(client) }
                    }
                }
            } catch (e: Throwable) {
                if (isActive) _events.emit(NearbyEvent.TransferError(e))
            }
        }
    }

    private suspend fun receiveFiles(socket: Socket) {
        socket.use {
            try {
                val input = DataInputStream(socket.getInputStream())
                val count = input.readInt()
                repeat(count) {
                    val name = input.readUTF()
                    val size = input.readLong()
                    val outDir = context.getExternalFilesDir(null) ?: context.filesDir
                    val outFile = File(outDir, name)
                    FileOutputStream(outFile).use { fos ->
                        val buf = ByteArray(CHUNK_SIZE)
                        var received = 0L
                        while (received < size) {
                            val toRead = minOf(buf.size.toLong(), size - received).toInt()
                            val n = input.read(buf, 0, toRead)
                            if (n == -1) break
                            fos.write(buf, 0, n)
                            received += n
                            _events.emit(NearbyEvent.ReceiveProgress(name, received, size))
                        }
                    }
                    _events.emit(NearbyEvent.ReceiveComplete(name, outFile))
                }
            } catch (e: Throwable) {
                _events.emit(NearbyEvent.TransferError(e))
            }
        }
    }
}
