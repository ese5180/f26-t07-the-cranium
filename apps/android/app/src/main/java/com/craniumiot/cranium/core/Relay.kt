package com.craniumiot.cranium.core

/**
 * The Bluetooth relay (firmware 1.21.0, docs/ble-relay.md), with no Bluetooth and no sockets in it: the
 * frames the app and a board say on the L2CAP channel (firmware/app/src/policy/ble_relay_proto.h), and what
 * the app does with them. ble/RelayLink.kt does the radio and TCP. RelayTest holds the board's own sample bytes
 * (`build/ble_relay_tests --print` in firmware/tests/host), as the iPhone app's RelayProtocolTests does.
 *
 * Each frame is a type byte, a 16-bit little-endian length and that many bytes, at most 512.
 */
object RelayProtocol {
    /** The relay's GATT service, which the board advertises, and its one characteristic: the PSM, 2 bytes LE. */
    const val SERVICE_UUID = "D38F3C14-34A8-4CDD-8E9A-BDB7FE83A2F0"
    const val PSM_UUID = "D38F3C15-34A8-4CDD-8E9A-BDB7FE83A2F0"
    const val VERSION = 1
    const val HEADER_LENGTH = 3
    const val PAYLOAD_MAX = 512
    /** AWS IoT's MQTT over TLS: the only port the app relays to. */
    const val PORT = 8883

    const val HELLO = 0x01
    const val OPEN = 0x02
    const val OPENED = 0x03
    const val DATA = 0x04
    const val CLOSE = 0x05

    const val NORMAL = 0
    const val REFUSED = 1
    const val CONNECT_FAILED = 2
    const val PEER_CLOSED = 3
    const val TIMEOUT = 4
    const val PROTOCOL = 5
    const val HANDBACK = 6

    fun frame(type: Int, payload: ByteArray = ByteArray(0)): ByteArray {
        require(payload.size <= PAYLOAD_MAX) { "a frame carries at most 512 bytes" }
        return byteArrayOf(type.toByte(), (payload.size and 0xff).toByte(), (payload.size shr 8).toByte()) + payload
    }

    fun opened(): ByteArray = frame(OPENED)

    fun close(reason: Int): ByteArray = frame(CLOSE, byteArrayOf(reason.toByte()))

    /** Stream bytes as DATA frames of at most [max] bytes each. */
    fun data(bytes: ByteArray, max: Int = PAYLOAD_MAX): ByteArray {
        val size = max.coerceIn(1, PAYLOAD_MAX)
        val out = java.io.ByteArrayOutputStream(bytes.size + (bytes.size / size + 1) * HEADER_LENGTH)
        var at = 0
        while (at < bytes.size) {
            val end = minOf(at + size, bytes.size)
            out.write(frame(DATA, bytes.copyOfRange(at, end)))
            at = end
        }
        return out.toByteArray()
    }

    /**
     * Whether the app may open TCP to this host and port for a board: AWS IoT's ATS data endpoint, in the region
     * this app is configured for, on 8883. No endpoint is written into the app; a board, or anything that says it
     * is one, cannot use the phone to reach anywhere else.
     */
    fun allowed(host: String, port: Int, region: String): Boolean {
        if (port != PORT || !Regex("^[a-z0-9-]{1,32}$").matches(region)) return false
        return Regex("^[a-z0-9]{1,64}-ats\\.iot\\.${Regex.escape(region)}\\.amazonaws\\.com$").matches(host)
    }
}

sealed class RelayMessage {
    data class Hello(val version: Int, val flags: Int, val dataMax: Int, val thing: String) : RelayMessage()
    data class Open(val host: String, val port: Int) : RelayMessage()
    data object Opened : RelayMessage()
    class Data(val bytes: ByteArray) : RelayMessage() {
        override fun equals(other: Any?) = other is Data && other.bytes.contentEquals(bytes)
        override fun hashCode() = bytes.contentHashCode()
        override fun toString() = "Data(${bytes.size})"
    }
    data class Close(val reason: Int) : RelayMessage()
}

/**
 * Reads frames out of the channel's byte stream as they come, whatever the pieces. A type it does not know is
 * skipped, so that a newer board can add frames; a length over 512, or a frame that cannot be read, breaks the
 * stream for good.
 */
class RelayReader {
    private var buffer = ByteArray(0)
    var broken = false
        private set

    fun feed(bytes: ByteArray): List<RelayMessage> {
        if (broken) return emptyList()
        buffer += bytes
        val messages = mutableListOf<RelayMessage>()
        while (buffer.size >= RelayProtocol.HEADER_LENGTH) {
            val type = buffer[0].toInt() and 0xff
            val length = (buffer[1].toInt() and 0xff) or ((buffer[2].toInt() and 0xff) shl 8)
            if (length > RelayProtocol.PAYLOAD_MAX) return breakOff(messages)
            if (buffer.size < RelayProtocol.HEADER_LENGTH + length) break
            val payload = buffer.copyOfRange(RelayProtocol.HEADER_LENGTH, RelayProtocol.HEADER_LENGTH + length)
            buffer = buffer.copyOfRange(RelayProtocol.HEADER_LENGTH + length, buffer.size)
            if (type !in RelayProtocol.HELLO..RelayProtocol.CLOSE) continue
            messages += message(type, payload) ?: return breakOff(messages)
        }
        return messages
    }

    private fun breakOff(messages: List<RelayMessage>): List<RelayMessage> {
        broken = true
        buffer = ByteArray(0)
        return messages
    }

    private fun message(type: Int, payload: ByteArray): RelayMessage? {
        fun u8(at: Int) = payload[at].toInt() and 0xff
        return when (type) {
            RelayProtocol.HELLO ->
                if (payload.size < 4) null
                else RelayMessage.Hello(u8(0), u8(1), u8(2) or (u8(3) shl 8), payload.copyOfRange(4, payload.size).decodeToString())
            RelayProtocol.OPEN ->
                if (payload.size < 3) null
                else RelayMessage.Open(payload.copyOfRange(2, payload.size).decodeToString(), u8(0) or (u8(1) shl 8))
            RelayProtocol.OPENED -> if (payload.isEmpty()) RelayMessage.Opened else null
            RelayProtocol.DATA -> RelayMessage.Data(payload)
            else -> RelayMessage.Close(if (payload.isEmpty()) RelayProtocol.NORMAL else u8(0))
        }
    }
}

/**
 * The relay's decisions for one board, as the iPhone app's RelayPump: what the app does with what the board
 * sends and what the server sends. The app reads nothing of the stream: DATA from the board goes to TCP as it
 * is, and TCP's bytes go back as DATA. It opens TCP only to the host the board names, only if
 * [RelayProtocol.allowed] says so, and only for the board the person picked.
 *
 * [expectedThing]: the board the person turned the relay on for, or null for whichever answers. [region]: the
 * app's configured AWS region.
 */
class RelayPump(private val expectedThing: String?, private val region: String) {
    sealed class State {
        data object WaitingHello : State()
        data class Ready(val thing: String) : State()
        data class Connecting(val thing: String, val host: String) : State()
        data class Relaying(val thing: String, val host: String) : State()
        data class Ended(val words: String) : State()
    }

    sealed class Action {
        class ToBoard(val bytes: ByteArray) : Action() {
            override fun equals(other: Any?) = other is ToBoard && other.bytes.contentEquals(bytes)
            override fun hashCode() = bytes.contentHashCode()
        }
        data class Connect(val host: String, val port: Int) : Action()
        class ToServer(val bytes: ByteArray) : Action() {
            override fun equals(other: Any?) = other is ToServer && other.bytes.contentEquals(bytes)
            override fun hashCode() = bytes.contentHashCode()
        }
        data object CloseServer : Action()
        data object CloseChannel : Action()
    }

    var state: State = State.WaitingHello
        private set
    var bytesUp = 0L
        private set
    var bytesDown = 0L
        private set

    private val reader = RelayReader()
    private var dataMax = RelayProtocol.PAYLOAD_MAX

    val thing: String?
        get() = when (val now = state) {
            is State.Ready -> now.thing
            is State.Connecting -> now.thing
            is State.Relaying -> now.thing
            else -> null
        }

    private val streaming: Boolean get() = state is State.Connecting || state is State.Relaying

    fun fromBoard(bytes: ByteArray): List<Action> {
        if (state is State.Ended) return emptyList()
        val actions = mutableListOf<Action>()
        for (message in reader.feed(bytes)) {
            actions += handle(message)
            if (state is State.Ended) return actions
        }
        if (reader.broken) return end("The board sent something the app cannot read.", actions)
        return actions
    }

    private fun handle(message: RelayMessage): List<Action> {
        val now = state
        return when {
            message is RelayMessage.Hello && now is State.WaitingHello -> when {
                message.version != RelayProtocol.VERSION ->
                    end("The board speaks another version of the relay (${message.version}). Update the app.")
                expectedThing != null && !expectedThing.equals(message.thing, ignoreCase = true) -> end("That is another board.")
                else -> {
                    dataMax = message.dataMax.coerceIn(1, RelayProtocol.PAYLOAD_MAX)
                    state = State.Ready(message.thing)
                    emptyList()
                }
            }
            message is RelayMessage.Open && now is State.Ready ->
                if (!RelayProtocol.allowed(message.host.lowercase(), message.port, region)) {
                    listOf(Action.ToBoard(RelayProtocol.close(RelayProtocol.REFUSED)))
                } else {
                    state = State.Connecting(now.thing, message.host)
                    listOf(Action.Connect(message.host, message.port))
                }
            message is RelayMessage.Data && now is State.Relaying -> {
                bytesUp += message.bytes.size
                if (message.bytes.isEmpty()) emptyList() else listOf(Action.ToServer(message.bytes))
            }
            // What was on its way when the stream was closed.
            message is RelayMessage.Data && now is State.Ready -> emptyList()
            message is RelayMessage.Close && now is State.Connecting -> {
                state = State.Ready(now.thing)
                listOf(Action.CloseServer)
            }
            message is RelayMessage.Close && now is State.Relaying -> {
                state = State.Ready(now.thing)
                listOf(Action.CloseServer)
            }
            message is RelayMessage.Close && now is State.Ready -> emptyList()
            else -> end("The board broke the relay's rules.")
        }
    }

    fun serverConnected(): List<Action> {
        val now = state as? State.Connecting ?: return listOf(Action.CloseServer)
        state = State.Relaying(now.thing, now.host)
        return listOf(Action.ToBoard(RelayProtocol.opened()))
    }

    fun serverFailed(): List<Action> {
        val now = state as? State.Connecting ?: return emptyList()
        state = State.Ready(now.thing)
        return listOf(Action.ToBoard(RelayProtocol.close(RelayProtocol.CONNECT_FAILED)))
    }

    fun fromServer(bytes: ByteArray): List<Action> {
        if (state !is State.Relaying || bytes.isEmpty()) return emptyList()
        bytesDown += bytes.size
        return listOf(Action.ToBoard(RelayProtocol.data(bytes, dataMax)))
    }

    fun serverClosed(): List<Action> = when (val now = state) {
        is State.Connecting -> {
            state = State.Ready(now.thing)
            listOf(Action.ToBoard(RelayProtocol.close(RelayProtocol.CONNECT_FAILED)))
        }
        is State.Relaying -> {
            state = State.Ready(now.thing)
            listOf(Action.ToBoard(RelayProtocol.close(RelayProtocol.PEER_CLOSED)))
        }
        else -> emptyList()
    }

    fun channelClosed(): List<Action> {
        if (state is State.Ended) return emptyList()
        val was = streaming
        state = State.Ended("The board went out of reach.")
        return if (was) listOf(Action.CloseServer) else emptyList()
    }

    fun stop(): List<Action> = end("Relay turned off.")

    private fun end(words: String, earlier: List<Action> = emptyList()): List<Action> {
        val was = streaming
        state = State.Ended(words)
        return earlier + (if (was) listOf(Action.CloseServer) else emptyList()) + Action.CloseChannel
    }
}
