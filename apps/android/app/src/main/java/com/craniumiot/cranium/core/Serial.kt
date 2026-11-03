package com.craniumiot.cranium.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CharsetDecoder
import java.nio.charset.CodingErrorAction

/**
 * The serial console's rules, after the website's serial.js and the firmware's
 * firmware/app/src/console_cmd.c: one command per line, `COMMAND|arg1|arg2`; a reply ends with
 * exactly one final line, `OK …` or `ERR …`; a line that starts with `[TAG]` is a log line or an
 * event and can come at any time.
 *
 * A Wi-Fi password is never shown, stored or kept. The transcript holds a masked copy of a
 * command, the history leaves such a command out, and the bytes that went to the board are
 * overwritten once they are written.
 */
object SerialRules {
    const val BAUD_RATE = 115_200
    const val SEGGER_VENDOR_ID = 0x1366
    const val PROBE_MS = 2_000L
    const val REPLY_MS = 10_000L
    const val RESTART_SETTLE_MS = 300L

    // The firmware's limits.
    const val LINE_MAX = 384
    const val ID_MAX = 32
    const val SSID_MAX = 32
    const val PASSWORD_MIN = 8
    const val PASSWORD_MAX = 63
    const val ENDPOINT_MAX = 127
    private const val NAME_SHOWN_MAX = 32

    const val LINES_KEPT = 1000
    const val COMMANDS_KEPT = 50
    const val PARTIAL_MAX = 4096
    const val REPLY_LINES_KEPT = 64

    const val MASK = "••••••"

    private fun byteLength(text: String) = text.toByteArray(Charsets.UTF_8).size

    // The reader's is_control(): a tab is allowed.
    private val CONTROL = Regex("[\\u0000-\\u0008\\u000a-\\u001f\\u007f]")

    enum class Rule { ID, SSID, PASSWORD, HOST }

    /** What is wrong with a value, in the firmware's words, or null. */
    fun check(rule: Rule, value: String): String? = when (rule) {
        Rule.ID -> if (Regex("^[0-9A-Za-z]{1,32}$").matches(value)) null else "id must be 1-$ID_MAX letters or digits"
        Rule.SSID -> {
            val bytes = byteLength(value)
            when {
                bytes == 0 || bytes > SSID_MAX -> "ssid must be 1-$SSID_MAX bytes"
                value.contains('|') -> "ssid cannot contain |"
                CONTROL.containsMatchIn(value) -> "ssid cannot contain a control character"
                else -> null
            }
        }
        Rule.PASSWORD -> {
            val bytes = byteLength(value)
            when {
                value.isEmpty() -> "open networks are not allowed"
                bytes < PASSWORD_MIN || bytes > PASSWORD_MAX -> "password must be $PASSWORD_MIN-$PASSWORD_MAX characters"
                CONTROL.containsMatchIn(value) -> "password cannot contain a control character"
                else -> null
            }
        }
        Rule.HOST -> {
            val shaped = value.length <= ENDPOINT_MAX && Regex("^[0-9A-Za-z][0-9A-Za-z.-]*$").matches(value) && value.contains('.')
            if (shaped) null else "endpoint must be a host name of at most $ENDPOINT_MAX letters, digits, dots and hyphens"
        }
    }

    data class Field(
        val key: String,
        val label: String,
        val rule: Rule? = null,
        val choices: List<String>? = null,
        val secret: Boolean = false,
        val optional: Boolean = false,
        val hint: String? = null,
    )

    data class Command(
        val name: String,
        val group: String?,
        val factory: Boolean,
        val minArgs: Int,
        val maxArgs: Int,
        val fields: List<Field> = emptyList(),
        val text: String = "",
        val confirm: String? = null,
        val alias: String? = null,
    )

    val ID_FIELD = Field("id", "ID", rule = Rule.ID, hint = "1 to $ID_MAX letters or digits.")
    val SSID_FIELD = Field("ssid", "Network name", rule = Rule.SSID, hint = "1 to $SSID_MAX bytes, without a |.")
    val PASSWORD_FIELD = Field(
        "password", "Password", rule = Rule.PASSWORD, secret = true,
        hint = "$PASSWORD_MIN to $PASSWORD_MAX characters; open networks are not allowed. Cleared as soon as it is sent.",
    )
    val SECURITY_FIELD = Field("security", "Security", choices = listOf("WPA2_PSK", "WPA2_PSK_SHA256", "WPA3_SAE"))
    val SECTION_FIELD = Field("section", "Section", optional = true, choices = listOf("", "device", "wifi", "cloud", "certs", "update"))
    val HOST_FIELD = Field(
        "host", "Server", rule = Rule.HOST,
        hint = "The AWS IoT endpoint, such as xxxxxxxxxxxxxx-ats.iot.us-east-1.amazonaws.com. The download prefix stays as it is.",
    )

    val COMMANDS = listOf(
        Command("GET_ID", "identity", true, 0, 0, text = "Ask for the ID and the firmware version."),
        Command("SET_ID", "identity", false, 1, 1, listOf(ID_FIELD), "Change the ID and keep everything else."),
        Command(
            "INIT", "identity", true, 1, 1, listOf(ID_FIELD),
            "First-time setup: erases everything on the board, stores the ID and restarts.", confirm = "INIT",
        ),
        Command("WIFI", "wifi", false, 2, 2, listOf(SSID_FIELD, PASSWORD_FIELD), "Save a WPA2 network and join it."),
        Command("WIFI_SEC", "wifi", false, 3, 3, listOf(SSID_FIELD, SECURITY_FIELD, PASSWORD_FIELD), "The same, with the security mode named."),
        Command("CLEAR_WIFI", "wifi", false, 0, 0, text = "Erase the network and disconnect."),
        Command("NET", "wifi", false, 0, 0, text = "Show connection state, name, IP, signal and MAC."),
        Command("MQTT", "mqtt", false, 0, 0, text = "Ask how the connection to AWS IoT stands."),
        Command("MQTT_HOST", "mqtt", false, 1, 1, listOf(HOST_FIELD), "Change the AWS IoT endpoint only, and reconnect to it."),
        Command("MQTT_RECONNECT", "mqtt", false, 0, 0, text = "Drop the MQTT connection and connect again now."),
        Command("STATS", "status", false, 0, 0, text = "State, ID, firmware, Wi-Fi, uptime, memory, last reset."),
        Command("STATUS", "status", false, 0, 1, listOf(SECTION_FIELD), "Print the configuration, or one section of it."),
        Command("HELP", "status", true, 0, 0, text = "List the commands of this firmware.", alias = "?"),
        Command("REBOOT", "maintenance", true, 0, 0, text = "Restart the board."),
        Command("ENTER_BOOTLOADER", "maintenance", true, 0, 0, text = "Restart; catch the bootloader with tools/recover.py --console."),
        Command(
            "RESET_CONFIG", "maintenance", false, 0, 0,
            text = "Clear the cloud settings only. Keeps the ID, Wi-Fi, certificates and key.",
        ),
        Command(
            "FACTORY_RESET", "maintenance", false, 0, 0,
            text = "Erase everything, also the ID, and restart in factory mode.", confirm = "FACTORY_RESET",
        ),
        Command("THING", null, true, 0, 0),
        Command("ECHO", null, true, 1, 1),
        Command("CLOUD", null, false, 1, 2),
        Command("KEYGEN", null, false, 0, 1),
        Command("STREAM_START", null, false, 4, 4),
        Command("STREAM_CHUNK", null, false, 2, 2),
        Command("STREAM_STATUS", null, false, 0, 0),
        Command("STREAM_CANCEL", null, false, 0, 0),
        Command("BUTTON", null, false, 1, 1),
    )

    private val KNOWN: Map<String, Command> = COMMANDS.flatMap { command ->
        listOfNotNull(command.name to command, command.alias?.let { it to command })
    }.toMap()

    fun command(name: String): Command? = KNOWN[name]

    val GROUPS = listOf(
        "identity" to "Identity",
        "wifi" to "Wi-Fi",
        "mqtt" to "MQTT",
        "status" to "Status",
        "maintenance" to "Maintenance",
    )

    /** How many arguments come before the password. */
    private val BEFORE_SECRET = mapOf("WIFI" to 1, "WIFI_SEC" to 2)

    /** The name of the command on a line, in capitals: what the firmware compares. */
    fun commandName(line: String): String {
        val bar = line.indexOf('|')
        return (if (bar < 0) line else line.substring(0, bar)).trim().uppercase()
    }

    /** Whether a line holds, or is on its way to holding, a Wi-Fi password. */
    fun holdsSecret(line: String): Boolean = commandName(line) in BEFORE_SECRET && line.contains('|')

    /**
     * A command as it may be shown. The password of a Wi-Fi command is masked, and so is anything
     * that may be one. Of a name that is not a command only the name is shown.
     */
    fun shownCommand(line: String): String {
        val text = line.trimStart()
        val bar = text.indexOf('|')
        val name = commandName(text)
        if (bar < 0) return if (name in KNOWN) text.trim() else text.trim().take(NAME_SHOWN_MAX)
        val written = text.substring(0, bar).trim()
        val before = BEFORE_SECRET[name]
        if (before != null) {
            val fields = text.substring(bar + 1).split('|')
            val whole = fields.size > before &&
                (name != "WIFI_SEC" || fields[1].trim().uppercase() in SECURITY_FIELD.choices!!)
            return (listOf(written) + (if (whole) fields.take(before) else emptyList()) + MASK).joinToString("|")
        }
        return if (name in KNOWN) text else "${written.take(NAME_SHOWN_MAX)}|$MASK"
    }

    data class Checked(val errors: Map<String, String>, val line: String)

    /** Check what a form holds against the firmware's rules, and build its line. */
    fun checkCommand(command: Command, values: Map<String, String>): Checked {
        val errors = linkedMapOf<String, String>()
        val parts = mutableListOf(command.name)
        for (field in command.fields) {
            val value = values[field.key].orEmpty()
            if (field.choices != null) {
                if (value !in field.choices) errors[field.key] = "${field.label} must be one of the choices"
            } else if (field.rule != null) {
                check(field.rule, value)?.let { errors[field.key] = it }
            }
            if (value.isNotEmpty() || !field.optional) parts += value
        }
        if (command.confirm != null && values["confirm"] != command.confirm) errors["confirm"] = "Type ${command.confirm} to confirm"
        val line = parts.joinToString("|")
        if (errors.isEmpty() && byteLength(line) > LINE_MAX) {
            errors[command.fields.firstOrNull()?.key ?: "confirm"] = "line too long, the limit is $LINE_MAX bytes"
        }
        return Checked(errors, line)
    }

    sealed class Typed {
        data object Empty : Typed()
        data class Refused(val why: String) : Typed()
        data class Send(val line: String, val keep: Boolean) : Typed()
    }

    /** What to do with a line from the free input. What erases the board goes through its form. */
    fun checkTyped(typed: String): Typed {
        val line = typed.trimStart()
        if (line.isBlank()) return Typed.Empty
        if (byteLength(line) > LINE_MAX) return Typed.Refused("line too long, the limit is $LINE_MAX bytes")
        if (CONTROL.containsMatchIn(line)) return Typed.Refused("a line cannot hold a control character")
        val name = commandName(line)
        val command = KNOWN[name]
        if (command?.confirm != null) {
            return Typed.Refused("${command.name} erases the board, so it asks for a typed confirmation: use its form on this page.")
        }
        if (name == "ECHO" && Regex("\\|\\s*on\\s*$", RegexOption.IGNORE_CASE).containsMatchIn(line)) {
            return Typed.Refused(
                "Echo stays off on this page, so that the board does not send back what is typed. A plain serial monitor can turn it on.",
            )
        }
        return Typed.Send(line, keep = command != null && name !in BEFORE_SECRET)
    }

    /** What kind of line the board sent. */
    sealed class Received {
        data class Tag(val tag: String, val level: String?, val text: String) : Received()
        data class Final(val ok: Boolean, val text: String) : Received()
        data class Output(val text: String) : Received()
    }

    private val ESCAPES = Regex("\\u001b\\[[0-9;?]*[ -/]*[@-~]")
    private val UNPRINTABLE = Regex("[\\u0000-\\u0008\\u000b-\\u001f\\u007f]")
    private val TAG_LINE = Regex("^\\[([^\\]\\s]{1,32})\\] ?(.*)$", RegexOption.DOT_MATCHES_ALL)
    private val FINAL_LINE = Regex("^(OK|ERR)(?: (.*))?$", RegexOption.DOT_MATCHES_ALL)
    private val LEVEL = Regex("^(ERR|WRN): (.*)$", RegexOption.DOT_MATCHES_ALL)

    fun classifyLine(raw: String): Received? {
        val text = raw.replace(ESCAPES, "").replace(UNPRINTABLE, "")
        if (text.isBlank()) return null
        TAG_LINE.matchEntire(text)?.let { tagged ->
            val level = LEVEL.matchEntire(tagged.groupValues[2])
            return Received.Tag(tagged.groupValues[1], level?.groupValues?.get(1), level?.groupValues?.get(2) ?: tagged.groupValues[2])
        }
        FINAL_LINE.matchEntire(text)?.let { final ->
            return Received.Final(final.groupValues[1] == "OK", final.groupValues[2])
        }
        return Received.Output(text)
    }

    private val KEY_VALUE = Regex("^([A-Za-z][A-Za-z ]*?) {2,}(\\S.*)$")

    private val MQTT_LABELS = mapOf(
        "state" to "State", "endpoint" to "Server", "port" to "Port", "client id" to "Client ID", "keep alive" to "Keep-alive",
        "tls sec tag" to "TLS sec tag", "connected for" to "Connected for", "attempts" to "Attempts", "connects" to "Connects",
        "disconnects" to "Disconnects", "errors" to "Errors", "last error" to "Last error", "published" to "Published",
        "received" to "Received", "last publish" to "Last publish", "last receive" to "Last receive", "subscribed" to "Subscribed to",
    )

    /** Facts of MQTT's answer whose values are identifiers, set in the monospace face. */
    val MONO_FACTS = setOf("endpoint", "client id", "subscribed")

    data class MqttFact(val key: String, val label: String, val values: List<String>)

    /** The lines of a reply to MQTT as facts, in the board's order. A key that comes again has several values. */
    fun mqttFacts(lines: List<String>): List<MqttFact> {
        val facts = mutableListOf<MqttFact>()
        for (text in lines) {
            val match = KEY_VALUE.matchEntire(text) ?: continue
            val (key, value) = match.destructured
            val known = facts.indexOfFirst { it.key == key }
            if (known >= 0) facts[known] = facts[known].copy(values = facts[known].values + value)
            else facts += MqttFact(key, MQTT_LABELS[key] ?: key, listOf(value))
        }
        return facts
    }

    private val ECHOED_SECRET = Regex("^(?:> ?)?(wifi(?:_sec)?\\|.*)$", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))

    /** A line of output as it may be shown: a Wi-Fi command coming back is masked like one going out. */
    fun shownOutput(text: String): String = ECHOED_SECRET.matchEntire(text)?.let { shownCommand(it.groupValues[1]) } ?: text

    /** A line of a box, or of HELP's table, keeps its columns. */
    val COLUMNS = Regex("^(?:[+|]|[* ] )")

    const val OTHER_PORT = "No answer in 2 seconds, so this looks like the other port. The DK has two virtual COM ports " +
        "and only one carries the console: try the other one."
    const val UNPLUGGED = "The connection to the board ended. The USB cable may have come out, or the board lost power."
    const val OLD_FIRMWARE = "The firmware on this board is older than the MQTT commands. Update it to use them."
}

/**
 * Turns reads of any size into lines. CR, LF and CRLF each end one line, also when the CRLF or a
 * character is split over two reads. A line that never ends is cut off at a limit.
 */
class LineReader {
    private val decoder: CharsetDecoder = Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPLACE)
        .onUnmappableCharacter(CodingErrorAction.REPLACE)
    private val pending = ByteArrayOutputStream()
    private val partial = StringBuilder()
    private var afterCr = false

    fun feed(bytes: ByteArray): List<String> {
        pending.write(bytes)
        val input = ByteBuffer.wrap(pending.toByteArray())
        val output = CharBuffer.allocate(input.remaining() + 1)
        decoder.decode(input, output, false)
        // What is left is the start of a character that the next read finishes.
        val rest = ByteArray(input.remaining()).also { input.get(it) }
        pending.reset()
        pending.write(rest)
        output.flip()
        val lines = mutableListOf<String>()
        for (character in output) {
            val lfOfCrlf = afterCr && character == '\n'
            afterCr = character == '\r'
            if (lfOfCrlf) continue
            if (character == '\r' || character == '\n') {
                lines += partial.toString()
                partial.setLength(0)
            } else {
                partial.append(character)
                if (partial.length >= SerialRules.PARTIAL_MAX) {
                    lines += partial.toString()
                    partial.setLength(0)
                }
            }
        }
        return lines
    }

    /** What is left when the connection ends: a line that was never finished, if any. */
    fun flush(): String? {
        val rest = partial.toString()
        partial.setLength(0)
        pending.reset()
        afterCr = false
        decoder.reset()
        return rest.ifEmpty { null }
    }
}

/** The cable to a board, as the session sees it. */
interface SerialLink {
    /** Write these bytes, in order with every other write. Throws if the port is gone. */
    suspend fun write(bytes: ByteArray)

    /** Close the port. No more reads arrive afterwards. */
    suspend fun close()
}

/**
 * One connection to one board, and everything the page shows about it (serial.js
 * createSerialSession). Call everything on one thread, the main one: reads are handed in with
 * [received], and timers run on [scope].
 */
class SerialSession(private val scope: CoroutineScope, private val clock: () -> String) {
    enum class Phase { IDLE, OPENING, PROBING, SILENT, READY, CLOSING }

    enum class Kind { SENT, OK, ERR, TAG, OUTPUT, NOTE }

    enum class NoteTone { IDLE, WARN, BAD }

    data class Line(
        val id: Long,
        val kind: Kind,
        val text: String,
        val at: String,
        val tag: String? = null,
        val level: String? = null,
        val auto: Boolean = false,
        val tone: NoteTone = NoteTone.IDLE,
    )

    enum class ReplyKind { WAIT, OK, ERR, NONE }

    data class Reply(val form: String, val kind: ReplyKind, val text: String)

    data class BoardId(val id: String, val version: String)

    data class Mqtt(val facts: List<SerialRules.MqttFact>, val at: String, val stale: Boolean)

    data class State(
        val phase: Phase = Phase.IDLE,
        val problem: String? = null,
        val board: BoardId? = null,
        val mqtt: Mqtt? = null,
        val lines: List<Line> = emptyList(),
        val linesDropped: Int = 0,
        /** The last final line, for a screen reader. */
        val said: String = "",
        val saidCount: Int = 0,
        val typed: List<String> = emptyList(),
        val reply: Reply? = null,
    )

    data class Sent(val sent: Boolean, val problem: String? = null)

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    private var link: SerialLink? = null
    private var lineReader = LineReader()
    private var nextId = 1L
    private var restartTimer: Job? = null
    private var settling: Job? = null

    private class Waiting(
        val shown: String,
        val name: String,
        val form: String?,
        val result: CompletableDeferred<SerialRules.Received.Final?>,
        val lines: MutableList<String>?,
    ) {
        var echoed = false
        var timer: Job? = null
    }

    private val waiting = ArrayDeque<Waiting>()

    val isOpen: Boolean get() = link != null

    private fun add(line: Line) {
        _state.update { s ->
            val all = s.lines + line
            val over = (all.size - SerialRules.LINES_KEPT).coerceAtLeast(0)
            s.copy(lines = if (over > 0) all.drop(over) else all, linesDropped = s.linesDropped + over)
        }
    }

    private fun line(kind: Kind, text: String, tag: String? = null, level: String? = null, auto: Boolean = false, tone: NoteTone = NoteTone.IDLE) =
        Line(nextId++, kind, text, clock(), tag, level, auto, tone)

    fun note(text: String, tone: NoteTone = NoteTone.IDLE) = add(line(Kind.NOTE, text, tone = tone))

    fun setPhase(phase: Phase, problem: String? = _state.value.problem) = _state.update { it.copy(phase = phase, problem = problem) }

    fun clear() = _state.update { it.copy(lines = emptyList(), linesDropped = 0) }

    /** Keep a command for recall, unless it is the one before it. */
    fun remember(command: String) = _state.update { s ->
        if (s.typed.lastOrNull() == command) s else s.copy(typed = (s.typed + command).takeLast(SerialRules.COMMANDS_KEPT))
    }

    /** The port is open: say so and ask who is there. Nothing else is sent until something answers. */
    fun attach(opened: SerialLink) {
        link = opened
        lineReader = LineReader()
        _state.update { it.copy(problem = null, board = null, mqtt = null) }
        note("Port open at ${SerialRules.BAUD_RATE} baud.")
        scope.launch { probe() }
    }

    /** Send a line and wait for its final line; null if none comes. */
    suspend fun exec(
        command: String,
        wait: Long = SerialRules.REPLY_MS,
        auto: Boolean = false,
        form: String? = null,
    ): SerialRules.Received.Final? {
        val current = link ?: return null
        val shown = SerialRules.shownCommand(command)
        val name = SerialRules.commandName(command)
        add(line(Kind.SENT, shown, auto = auto))
        if (form != null) _state.update { it.copy(reply = Reply(form, ReplyKind.WAIT, "Sent, waiting for the board.")) }
        val entry = Waiting(shown, name, form, CompletableDeferred(), if (name == "MQTT") mutableListOf() else null)
        entry.timer = scope.launch {
            delay(wait)
            if (waiting.remove(entry)) {
                if (!auto) note("No reply to $name after ${wait / 1000} seconds.", NoteTone.WARN)
                if (form != null) {
                    _state.update { s ->
                        if (s.reply?.form == form) s.copy(reply = Reply(form, ReplyKind.NONE, "No reply from the board.")) else s
                    }
                }
                entry.result.complete(null)
            }
        }
        waiting.addLast(entry)
        val bytes = "$command\r\n".toByteArray(Charsets.UTF_8)
        try {
            current.write(bytes)
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            if (link != null) lost("Writing to the port failed. The board may have been disconnected.")
        } finally {
            // The string cannot be wiped. Its bytes can.
            bytes.fill(0)
        }
        return entry.result.await()
    }

    /**
     * Send a line from the page. Before a line with a password the board is told again not to
     * echo, and the line is not sent if it does not confirm that.
     */
    suspend fun send(command: String, form: String? = null): Sent {
        if (_state.value.phase != Phase.READY) return Sent(false, "Connect to a board first.")
        if (SerialRules.holdsSecret(command)) {
            val quiet = exec("ECHO|OFF", SerialRules.PROBE_MS, auto = true)
            if (quiet?.ok != true || link == null) {
                return Sent(false, "The board did not confirm that its echo is off, so the password was not sent. Type it again.")
            }
        }
        scope.launch { exec(command, form = form) }
        return Sent(true)
    }

    /** Bytes from the port. */
    fun received(bytes: ByteArray) {
        for (raw in lineReader.feed(bytes)) take(raw)
    }

    private fun take(raw: String) {
        when (val received = SerialRules.classifyLine(raw) ?: return) {
            is SerialRules.Received.Final -> finalLine(received)
            is SerialRules.Received.Tag -> {
                add(line(Kind.TAG, received.text, tag = received.tag, level = received.level))
                if (received.tag == "BOOT") restarted()
            }
            is SerialRules.Received.Output -> {
                val asCommand = SerialRules.shownCommand(received.text)
                val echo = waiting.firstOrNull { !it.echoed && it.shown == asCommand }
                if (echo != null) {
                    echo.echoed = true
                    return
                }
                val answering = waiting.firstOrNull()
                if (answering?.lines != null && answering.lines.size < SerialRules.REPLY_LINES_KEPT) answering.lines += received.text
                add(line(Kind.OUTPUT, SerialRules.shownOutput(received.text)))
            }
        }
    }

    private fun finalLine(final: SerialRules.Received.Final) {
        val entry = waiting.removeFirstOrNull()
        if (entry != null) {
            entry.timer?.cancel()
            _state.update { s ->
                var next = s
                if (entry.form != null) next = next.copy(reply = Reply(entry.form, if (final.ok) ReplyKind.OK else ReplyKind.ERR, final.text))
                if (entry.name == "GET_ID" && final.ok) {
                    val bar = final.text.lastIndexOf('|')
                    next = next.copy(
                        board = if (bar < 0) BoardId(final.text, "") else BoardId(final.text.substring(0, bar), final.text.substring(bar + 1)),
                    )
                }
                if (entry.name == "MQTT") {
                    next = next.copy(mqtt = if (final.ok) Mqtt(SerialRules.mqttFacts(entry.lines.orEmpty()), clock(), false) else null)
                }
                if ((entry.name == "MQTT_HOST" || entry.name == "MQTT_RECONNECT") && final.ok && next.mqtt != null) {
                    next = next.copy(mqtt = next.mqtt.copy(stale = true))
                }
                next
            }
        }
        add(line(if (final.ok) Kind.OK else Kind.ERR, final.text))
        _state.update {
            it.copy(said = "${if (final.ok) "OK" else "Error"}${if (final.text.isNotEmpty()) ": ${final.text}" else ""}", saidCount = it.saidCount + 1)
        }
        entry?.result?.complete(final)
        // A reply after the wait was over: there is a console on this port after all.
        if (_state.value.phase == Phase.SILENT) scope.launch { settle() }
    }

    /** A board that restarts has its echo on again, and may be another board by now. */
    private fun restarted() {
        if (restartTimer?.isActive == true) return
        if (_state.value.phase != Phase.READY && _state.value.phase != Phase.SILENT) return
        restartTimer = scope.launch {
            delay(SerialRules.RESTART_SETTLE_MS)
            when (_state.value.phase) {
                Phase.SILENT -> probe()
                Phase.READY -> {
                    scope.launch { exec("ECHO|OFF", SerialRules.PROBE_MS, auto = true) }
                    scope.launch { exec("GET_ID", SerialRules.PROBE_MS, auto = true) }
                }
                else -> Unit
            }
        }
    }

    private suspend fun settle() {
        if (settling?.isActive == true) {
            settling?.join()
            return
        }
        val job = scope.launch {
            exec("ECHO|OFF", SerialRules.PROBE_MS, auto = true)
            if (link != null) setPhase(Phase.READY, problem = null)
        }
        settling = job
        job.join()
    }

    /** Ask who is on the port. */
    suspend fun probe() {
        if (link == null) return
        setPhase(Phase.PROBING, problem = null)
        val answer = exec("GET_ID", SerialRules.PROBE_MS, auto = true)
        if (link == null) return
        if (answer != null) settle() else setPhase(Phase.SILENT, problem = SerialRules.OTHER_PORT)
    }

    private suspend fun shutDown(problem: String?) {
        val current = link ?: return
        link = null
        restartTimer?.cancel()
        restartTimer = null
        lineReader.flush()?.let(::take)
        _state.update { s ->
            s.copy(
                phase = Phase.CLOSING,
                problem = problem,
                board = null,
                mqtt = null,
                reply = if (s.reply?.kind == ReplyKind.WAIT) null else s.reply,
            )
        }
        while (waiting.isNotEmpty()) {
            val entry = waiting.removeFirst()
            entry.timer?.cancel()
            entry.result.complete(null)
        }
        runCatching { current.close() }
        setPhase(Phase.IDLE)
    }

    /** The port went away under the session: the cable, the board's power, or a failed write. */
    fun lost(problem: String) {
        if (link == null) return
        note(problem, NoteTone.BAD)
        scope.launch { shutDown(problem) }
    }

    suspend fun disconnect() {
        if (link == null) return
        note("Disconnected.")
        shutDown(null)
    }

    /** A problem from before a port was open: no permission, no board, the port would not open. */
    fun failedToOpen(problem: String) {
        _state.update { it.copy(phase = Phase.IDLE, problem = problem) }
    }
}
