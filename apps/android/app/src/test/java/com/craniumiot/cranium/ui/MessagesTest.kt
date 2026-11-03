package com.craniumiot.cranium.ui

import com.craniumiot.cranium.core.ApiError
import com.craniumiot.cranium.core.ApiJson
import com.craniumiot.cranium.core.SendNotCleared
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.UnknownHostException

/** What the app says when the console does not clear a Bluetooth send, and next to the passkey. */
class MessagesTest {

    @Test
    fun `offline, the app says that nothing was sent and why the phone's copy is not enough`() {
        for (e in listOf(IOException("no route"), UnknownHostException("console.example.com"))) {
            val text = Messages.notCleared("1.8.0+0", e)
            assertTrue(text, text.startsWith("Could not reach the console to check that 1.8.0+0 may still be sent, so nothing was sent."))
            assertTrue(text, text.contains("An image kept on this phone is only sent once the console says the release is still active."))
        }
    }

    @Test
    fun `a refusal by the console is shown in its own words`() {
        val revoked = ApiJson.error(409, """{"error": {"code": "release_revoked", "message": "Release 1.8.0+0 is revoked. Do not send it to a board."}}""")
        assertEquals(
            "The console did not clear 1.8.0+0 for sending, so nothing was sent. Release 1.8.0+0 is revoked. Do not send it to a board.",
            Messages.notCleared("1.8.0+0", revoked),
        )
        val other = SendNotCleared("The console did not confirm that this image of 1.8.0+0 is still active, so nothing was sent.")
        assertEquals(other.message, Messages.notCleared("1.8.0+0", other))
        assertTrue(Messages.notCleared("1.8.0+0", ApiError(500, "internal_error", "Something went wrong.")).contains("nothing was sent"))
        assertTrue(Messages.notCleared("1.8.0+0", IllegalStateException("odd")).startsWith("Nothing was sent: "))
    }

    @Test
    fun `the board the console names is shown as it is`() {
        assertEquals("Board in the console: cranium-0123456789abcdef", Messages.boardInConsole("cranium-0123456789abcdef"))
    }
}
