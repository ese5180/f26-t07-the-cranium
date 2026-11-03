package com.craniumiot.cranium.core

import com.craniumiot.cranium.core.SerialSession.Kind
import com.craniumiot.cranium.core.SerialSession.Phase
import com.craniumiot.cranium.core.SerialSession.Reply
import com.craniumiot.cranium.core.SerialSession.ReplyKind
import com.craniumiot.cranium.core.SerialSession.Sent
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/**
 * One connection to one board, on virtual time: who is there, the echo turned off before a
 * password, what is masked, what a restart does, and how a connection ends.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SerialSessionTest {
    private val password = "correct horse"

    /** The cable: records each line as the board gets it, and the arrays it was handed. */
    private class FakeLink : SerialLink {
        val written = mutableListOf<String>()
        val arrays = mutableListOf<ByteArray>()
        var closed = false
        var failing = false

        override suspend fun write(bytes: ByteArray) {
            if (failing) throw IOException("gone")
            // Read now: the session overwrites the array once this returns.
            written += bytes.decodeToString().removeSuffix("\r\n")
            arrays += bytes
        }

        override suspend fun close() {
            closed = true
        }
    }

    private fun SerialSession.say(vararg lines: String) =
        received(lines.joinToString("") { "$it\r\n" }.toByteArray(Charsets.UTF_8))

    private fun TestScope.newSession() = SerialSession(backgroundScope) { "12:00:00" }

    /** Attach, answer who is there and the echo, and come back ready. */
    private fun TestScope.ready(session: SerialSession, link: FakeLink) {
        session.attach(link)
        runCurrent()
        session.say("OK CRVIHAAN01|1.11.4+0")
        runCurrent()
        session.say("OK")
        runCurrent()
        assertEquals(Phase.READY, session.state.value.phase)
    }

    private fun SerialSession.texts() = state.value.lines.map { it.text }

    @Test
    fun `a board that answers is told to stop echoing, then it is ready`() = runTest {
        val session = newSession()
        val link = FakeLink()
        session.attach(link)
        runCurrent()
        assertEquals(listOf("GET_ID"), link.written)
        assertEquals(Phase.PROBING, session.state.value.phase)

        session.say("GET_ID")
        session.say("OK CRVIHAAN01|1.11.4+0")
        runCurrent()
        assertEquals(listOf("GET_ID", "ECHO|OFF"), link.written)
        assertEquals(Phase.PROBING, session.state.value.phase)

        session.say("OK")
        runCurrent()
        val state = session.state.value
        assertEquals(Phase.READY, state.phase)
        assertNull(state.problem)
        assertEquals(SerialSession.BoardId("CRVIHAAN01", "1.11.4+0"), state.board)
        // The command coming back was not news.
        assertEquals(listOf(Kind.NOTE, Kind.SENT, Kind.OK, Kind.SENT, Kind.OK), state.lines.map { it.kind })
        assertEquals("Port open at 115200 baud.", state.lines[0].text)
        assertTrue(state.lines[1].auto)
        assertEquals("12:00:00", state.lines[1].at)
        assertEquals("OK", state.said)
        assertEquals(2, state.saidCount)
    }

    @Test
    fun `no answer in 2 seconds is the other port, and a late answer makes it ready after all`() = runTest {
        val session = newSession()
        val link = FakeLink()
        session.attach(link)
        runCurrent()
        advanceTimeBy(1_999)
        runCurrent()
        assertEquals(Phase.PROBING, session.state.value.phase)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(Phase.SILENT, session.state.value.phase)
        assertEquals(SerialRules.OTHER_PORT, session.state.value.problem)
        // A question the page asked by itself does not leave a note when it goes unanswered.
        assertTrue(session.state.value.lines.none { it.kind == Kind.NOTE && it.text.startsWith("No reply") })

        session.say("OK CRVIHAAN01|1.11.4+0")
        runCurrent()
        assertEquals("ECHO|OFF", link.written.last())
        session.say("OK")
        runCurrent()
        assertEquals(Phase.READY, session.state.value.phase)
        assertNull(session.state.value.problem)
    }

    @Test
    fun `nothing is sent before a board is ready`() = runTest {
        val session = newSession()
        assertEquals(Sent(false, "Connect to a board first."), session.send("STATS"))
    }

    @Test
    fun `a wifi line goes only after the board confirms that its echo is off, and is shown masked`() = runTest {
        val session = newSession()
        val link = FakeLink()
        ready(session, link)
        val before = link.written.size

        val sent = async { session.send("WIFI|home|$password") }
        runCurrent()
        assertEquals(listOf("ECHO|OFF"), link.written.drop(before))

        session.say("OK")
        runCurrent()
        assertEquals(Sent(true), sent.await())
        assertEquals(listOf("ECHO|OFF", "WIFI|home|$password"), link.written.drop(before))
        assertEquals("WIFI|home|${SerialRules.MASK}", session.state.value.lines.last().text)

        // The board sending it back (its echo before ECHO|OFF took) is not news, and not shown.
        session.say("WIFI|home|$password")
        session.say("OK connecting")
        assertEquals("connecting", session.texts().last())
        assertTrue(session.texts().none { password in it })

        // Coming back once more, with nothing waiting for it, it is shown masked.
        session.say("wifi|home|$password")
        assertEquals("wifi|home|${SerialRules.MASK}", session.texts().last())
        assertTrue(session.texts().none { password in it })
        assertTrue(session.state.value.said.isNotEmpty() && password !in session.state.value.said)
    }

    @Test
    fun `without the board's word on its echo, the password is not sent`() = runTest {
        val session = newSession()
        val link = FakeLink()
        ready(session, link)
        val notSent = Sent(false, "The board did not confirm that its echo is off, so the password was not sent. Type it again.")

        val silent = async { session.send("WIFI|home|$password") }
        runCurrent()
        advanceTimeBy(SerialRules.PROBE_MS)
        runCurrent()
        assertEquals(notSent, silent.await())

        val refused = async { session.send("WIFI_SEC|home|WPA3_SAE|$password") }
        runCurrent()
        session.say("ERR busy")
        runCurrent()
        assertEquals(notSent, refused.await())

        assertTrue(link.written.none { password in it })
        assertTrue(session.texts().none { password in it })
    }

    @Test
    fun `the bytes that went to the board are overwritten afterwards`() = runTest {
        val session = newSession()
        val link = FakeLink()
        ready(session, link)
        val sent = async { session.send("WIFI|home|$password") }
        runCurrent()
        session.say("OK")
        runCurrent()
        sent.await()
        assertTrue(link.arrays.isNotEmpty())
        assertTrue(link.arrays.all { array -> array.all { it == 0.toByte() } })
    }

    @Test
    fun `a restart turns the echo off again and asks who is there, after a moment`() = runTest {
        val session = newSession()
        val link = FakeLink()
        ready(session, link)
        val before = link.written.size

        session.say("[BOOT] Cranium 1.11.5+0")
        runCurrent()
        assertEquals("BOOT", session.state.value.lines.last().tag)
        advanceTimeBy(SerialRules.RESTART_SETTLE_MS - 1)
        runCurrent()
        assertEquals(before, link.written.size)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(listOf("ECHO|OFF", "GET_ID"), link.written.drop(before))

        session.say("OK", "OK CRVIHAAN02|1.11.5+0")
        assertEquals(SerialSession.BoardId("CRVIHAAN02", "1.11.5+0"), session.state.value.board)
    }

    @Test
    fun `the answer to MQTT becomes facts, which a reconnection makes stale`() = runTest {
        val session = newSession()
        val link = FakeLink()
        ready(session, link)

        val check = async { session.send("MQTT", form = "MQTT") }
        runCurrent()
        assertEquals(Sent(true), check.await())
        assertEquals("MQTT", link.written.last())
        assertEquals(Reply("MQTT", ReplyKind.WAIT, "Sent, waiting for the board."), session.state.value.reply)

        session.say(
            "state          connected",
            "endpoint       a1b2-ats.iot.us-east-1.amazonaws.com",
            "subscribed     a/b",
            "subscribed     c/d",
            "OK",
        )
        val mqtt = session.state.value.mqtt!!
        assertEquals(listOf("state", "endpoint", "subscribed"), mqtt.facts.map { it.key })
        assertEquals(listOf("a/b", "c/d"), mqtt.facts.last().values)
        assertEquals("12:00:00", mqtt.at)
        assertFalse(mqtt.stale)
        assertEquals(Reply("MQTT", ReplyKind.OK, ""), session.state.value.reply)
        // The lines of the reply are in the transcript too.
        assertTrue(session.texts().contains("state          connected"))

        val reconnect = async { session.send("MQTT_RECONNECT", form = "MQTT_RECONNECT") }
        runCurrent()
        reconnect.await()
        session.say("OK reconnecting")
        assertTrue(session.state.value.mqtt!!.stale)
        assertEquals(Reply("MQTT_RECONNECT", ReplyKind.OK, "reconnecting"), session.state.value.reply)
    }

    @Test
    fun `a form says what the board answered, or that it did not`() = runTest {
        val session = newSession()
        val link = FakeLink()
        ready(session, link)

        val refused = async { session.send("SET_ID|CR2", form = "SET_ID") }
        runCurrent()
        refused.await()
        session.say("ERR id is locked")
        assertEquals(Reply("SET_ID", ReplyKind.ERR, "id is locked"), session.state.value.reply)
        assertEquals("Error: id is locked", session.state.value.said)

        val silent = async { session.send("STATS", form = "STATS") }
        runCurrent()
        silent.await()
        advanceTimeBy(SerialRules.REPLY_MS)
        runCurrent()
        assertEquals(Reply("STATS", ReplyKind.NONE, "No reply from the board."), session.state.value.reply)
        val note = session.state.value.lines.last()
        assertEquals(Kind.NOTE, note.kind)
        assertEquals("No reply to STATS after 10 seconds.", note.text)
        assertEquals(SerialSession.NoteTone.WARN, note.tone)
    }

    @Test
    fun `disconnecting ends what was waiting and leaves the session idle`() = runTest {
        val session = newSession()
        val link = FakeLink()
        ready(session, link)

        val pending = async { session.exec("STATS") }
        runCurrent()
        assertEquals("STATS", link.written.last())
        session.disconnect()
        assertNull(pending.await())
        val state = session.state.value
        assertEquals(Phase.IDLE, state.phase)
        assertNull(state.problem)
        assertNull(state.board)
        assertTrue(link.closed)
        assertFalse(session.isOpen)
        assertTrue(session.texts().contains("Disconnected."))
        assertEquals(Sent(false, "Connect to a board first."), session.send("STATS"))
    }

    @Test
    fun `a lost cable is said once, and the session ends with it as its problem`() = runTest {
        val session = newSession()
        val link = FakeLink()
        ready(session, link)

        session.lost(SerialRules.UNPLUGGED)
        val note = session.state.value.lines.last()
        assertEquals(Kind.NOTE, note.kind)
        assertEquals(SerialRules.UNPLUGGED, note.text)
        assertEquals(SerialSession.NoteTone.BAD, note.tone)
        runCurrent()
        assertEquals(Phase.IDLE, session.state.value.phase)
        assertEquals(SerialRules.UNPLUGGED, session.state.value.problem)
        assertTrue(link.closed)

        val lines = session.state.value.lines.size
        session.lost(SerialRules.UNPLUGGED)
        assertEquals(lines, session.state.value.lines.size)
    }

    @Test
    fun `a write that fails ends the session`() = runTest {
        val session = newSession()
        val link = FakeLink()
        ready(session, link)
        link.failing = true

        val pending = async { session.exec("STATS") }
        runCurrent()
        assertNull(pending.await())
        assertEquals(Phase.IDLE, session.state.value.phase)
        assertEquals("Writing to the port failed. The board may have been disconnected.", session.state.value.problem)
    }

    @Test
    fun `the transcript keeps the last 1000 lines and counts the rest`() = runTest {
        val session = newSession()
        val link = FakeLink()
        ready(session, link)
        val before = session.state.value.lines.size

        session.say(*Array(1005) { "[LOG] line $it" })
        val state = session.state.value
        assertEquals(SerialRules.LINES_KEPT, state.lines.size)
        assertEquals(before + 1005 - SerialRules.LINES_KEPT, state.linesDropped)
        assertEquals("line 1004", state.lines.last().text)

        session.clear()
        assertTrue(session.state.value.lines.isEmpty())
        assertEquals(0, session.state.value.linesDropped)
    }

    @Test
    fun `commands are kept for recall once each in a row, the last 50`() = runTest {
        val session = newSession()
        session.remember("STATS")
        session.remember("STATS")
        assertEquals(listOf("STATS"), session.state.value.typed)
        for (index in 0 until 60) session.remember("SET_ID|C$index")
        assertEquals(SerialRules.COMMANDS_KEPT, session.state.value.typed.size)
        assertEquals("SET_ID|C59", session.state.value.typed.last())
    }
}
