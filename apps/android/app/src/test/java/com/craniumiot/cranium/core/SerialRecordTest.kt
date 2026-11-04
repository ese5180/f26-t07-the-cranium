package com.craniumiot.cranium.core

import com.craniumiot.cranium.core.SerialSession.Phase
import com.craniumiot.cranium.core.SerialSession.Record
import com.craniumiot.cranium.core.SerialSession.ReplyKind
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The serial console's record of what it changed (serial.js recordCommand): after the board said
 * OK to a command that changes it, its name and the board as it gave itself go on record, and
 * nothing else. Never a value.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SerialRecordTest {
    private val password = "correct horse"

    private class FakeLink : SerialLink {
        val written = mutableListOf<String>()

        override suspend fun write(bytes: ByteArray) {
            written += bytes.decodeToString().removeSuffix("\r\n")
        }

        override suspend fun close() = Unit
    }

    private fun SerialSession.say(vararg lines: String) =
        received(lines.joinToString("") { "$it\r\n" }.toByteArray(Charsets.UTF_8))

    /** Connected to CRVIHAAN01 on 1.12.0+0, with a recorder that keeps what it was given. */
    private fun TestScope.ready(answer: String? = null, id: String = "CRVIHAAN01|1.12.0+0"): Triple<SerialSession, FakeLink, MutableList<SerialRecord>> {
        val session = SerialSession(backgroundScope) { "12:00:00" }
        val link = FakeLink()
        val recorded = mutableListOf<SerialRecord>()
        session.recorder = { record ->
            recorded += record
            answer
        }
        session.attach(link)
        runCurrent()
        session.say("OK $id")
        runCurrent()
        session.say("OK")
        runCurrent()
        assertEquals(Phase.READY, session.state.value.phase)
        return Triple(session, link, recorded)
    }

    @Test
    fun `a command that changed the board goes on record once it said OK, by name, with the board as it gave itself`() = runTest {
        val (session, _, recorded) = ready()
        val sent = async { session.send("WIFI|Lab|$password", form = "WIFI") }
        runCurrent()
        // ECHO|OFF goes first, on its own: not on record.
        session.say("OK")
        runCurrent()
        assertTrue(sent.await().sent)
        runCurrent()
        assertTrue(recorded.isEmpty())
        session.say("OK Wi-Fi saved")
        runCurrent()
        assertEquals(listOf(SerialRecord("WIFI", "CRVIHAAN01", "1.12.0+0")), recorded)
        // Nothing else goes in the body: no network, no password.
        val body = recorded.single().toJson()
        assertEquals("""{"command":"WIFI","device":"CRVIHAAN01","version":"1.12.0+0"}""", body)
        assertFalse(body.contains("Lab"))
        assertFalse(body.contains(password))
        val reply = session.state.value.reply!!
        assertEquals(ReplyKind.OK, reply.kind)
        assertEquals(Record.DONE, reply.record)
        assertTrue(session.state.value.lines.any { it.text == "WIFI is in the activity log, under your name." })
    }

    @Test
    fun `a refused command, a read, a probe or a command the API does not record goes on no record`() = runTest {
        val (session, _, recorded) = ready()
        session.send("REBOOT", form = "REBOOT")
        runCurrent()
        session.say("ERR not now")
        runCurrent()
        for (command in listOf("STATUS", "GET_ID", "MQTT", "ECHO|OFF")) {
            session.send(command)
            runCurrent()
            session.say("OK")
            runCurrent()
        }
        assertTrue(recorded.isEmpty())
        assertNull(session.state.value.reply?.record)
    }

    @Test
    fun `without a recorder, as for a viewer, nothing goes on record`() = runTest {
        val (session, _, recorded) = ready()
        session.recorder = null
        session.send("CLEAR_WIFI", form = "CLEAR_WIFI")
        runCurrent()
        session.say("OK")
        runCurrent()
        assertTrue(recorded.isEmpty())
        assertNull(session.state.value.reply?.record)
    }

    @Test
    fun `a record that did not get through says so under the reply, and the command was done all the same`() = runTest {
        val (session, _, _) = ready(answer = "At most 30 serial console commands a minute are recorded for one person.")
        session.send("REBOOT", form = "REBOOT")
        runCurrent()
        session.say("OK rebooting")
        runCurrent()
        val reply = session.state.value.reply!!
        assertEquals(Record.FAILED, reply.record)
        assertEquals(
            "Done on the board, but not in the activity log. At most 30 serial console commands a minute are recorded for one person.",
            reply.recordProblem,
        )
        assertTrue(session.state.value.lines.any { it.text.startsWith("REBOOT was done on the board, but it could not be put in the activity log.") })
    }

    @Test
    fun `a board in factory mode, or one that gave odd words, is recorded without them`() = runTest {
        val (session, _, recorded) = ready(id = "CR-01|1.12.0")
        session.send("INIT|CRVIHAAN02", form = "INIT")
        runCurrent()
        session.say("OK")
        runCurrent()
        assertEquals(listOf(SerialRecord("INIT")), recorded)
        assertEquals("""{"command":"INIT"}""", recorded.single().toJson())
        // The free command line counts as well, in any case.
        session.send("button")
        runCurrent()
        session.say("OK")
        runCurrent()
        assertEquals("BUTTON", recorded.last().command)
    }

    @Test
    fun `only the commands the API records are put on record`() {
        assertEquals(14, SerialRules.RECORDED.size)
        assertNull(SerialRules.record("STATUS", null))
        assertEquals(SerialRecord("KEYGEN", "B1", null), SerialRules.record("KEYGEN", SerialSession.BoardId("B1", "1.12")))
    }
}
