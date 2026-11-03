package com.craniumiot.cranium.ui

import com.craniumiot.cranium.auth.SignInException
import com.craniumiot.cranium.ble.ImageNote
import com.craniumiot.cranium.auth.SignedOutException
import com.craniumiot.cranium.core.ApiError
import com.craniumiot.cranium.core.CacheSummary
import com.craniumiot.cranium.core.ImageOrigin
import com.craniumiot.cranium.core.SendNotCleared
import kotlinx.serialization.SerializationException
import no.nordicsemi.android.mcumgr.ble.exception.McuMgrBluetoothDisabledException
import no.nordicsemi.android.mcumgr.ble.exception.McuMgrDisconnectedException
import no.nordicsemi.android.mcumgr.exception.McuMgrErrorException
import no.nordicsemi.android.mcumgr.exception.McuMgrTimeoutException
import java.io.IOException
import java.util.Locale

/** What the app says, after the error table in docs/mobile-apps.md. */
object Messages {
    const val NO_BOARD = "No board found. Hold Button 1 for 5 s, then look again."

    const val PAIRING_FAILED = "Pairing failed, or the board went away. A wrong passkey fails the pairing, " +
        "and three failures close the window. Open the window again (hold Button 1 for 5 s), and use the new passkey."

    const val REFUSED_AT_START = "The board refused the upload at the start: the release is not newer than what " +
        "it runs, or an image was already sent in this window. Pick a newer release, or open a new window."

    const val DISCONNECTED_DURING_UPLOAD = "Disconnected during the upload: out of range, or the window closed. " +
        "Open a new window and send it again: it starts over."

    const val DISCONNECTED = "The board disconnected: out of range, or the window closed. " +
        "Hold Button 1 for 5 s to open a new window, then look again."

    const val PASSKEY_ASKING = "Asking the console for the passkey…"

    const val PASSKEY_NOT_IN_CLOUD = "The console has no passkey for this board: it may not be online. " +
        "When the phone asks, type the passkey from the board's serial console, the line [BT] passkey."

    const val PASSKEY_NO_NAME = "The console only knows the passkey of a board named Cranium- and four hex " +
        "digits. Read it on the board's serial console, the line [BT] passkey."

    const val BLUETOOTH_OFF = "Bluetooth is off. Turn it on, then look again."

    /** Why connecting, pairing or reading the image list failed. */
    fun connectFailure(e: Throwable): String = when (e) {
        is McuMgrBluetoothDisabledException -> BLUETOOTH_OFF
        is McuMgrErrorException -> "The board refused to list its images (${e.message})."
        else -> PAIRING_FAILED
    }

    /** Why an upload failed. [bytesTaken] is how much the board had taken; [linkLost] if it disconnected. */
    fun uploadFailure(e: Throwable, bytesTaken: Int, linkLost: Boolean): String = when {
        linkLost || e is McuMgrDisconnectedException -> DISCONNECTED_DURING_UPLOAD
        e is McuMgrErrorException && bytesTaken == 0 -> REFUSED_AT_START
        e is McuMgrTimeoutException -> "The board stopped answering during the upload. " +
            "Open a new window and send it again: it starts over."
        else -> "The upload failed (${e.message ?: e.javaClass.simpleName}). " +
            "Open a new window and send it again: it starts over."
    }

    /** Next to the passkey: the board the console says is pairing under this name. */
    fun boardInConsole(thing: String): String = "Board in the console: $thing"

    /**
     * Why an image was not sent: the console did not clear it right before the upload. Offline is
     * a refusal too: an image kept on the phone is never sent without the console's word.
     */
    fun notCleared(version: String, e: Throwable): String = when (e) {
        is SendNotCleared -> e.message ?: "The console did not clear $version, so nothing was sent."
        is ApiError -> "The console did not clear $version for sending, so nothing was sent. ${e.message}"
        is IOException -> "Could not reach the console to check that $version may still be sent, so nothing was sent. " +
            "An image kept on this phone is only sent once the console says the release is still active. " +
            "Check the phone's connection, then send again."
        else -> "Nothing was sent: ${describe(e)}"
    }

    /** Where the image that is sent came from, and its size. */
    fun imageOrigin(note: ImageNote): String = when (note.origin) {
        ImageOrigin.PHONE ->
            "The image was already on this phone (${kilobytes(note.bytes)}) and passed the check again, so nothing was downloaded."
        ImageOrigin.DOWNLOADED ->
            "The image was downloaded from the console just now (${kilobytes(note.bytes)}) and checked."
    }

    /** The checked images the phone keeps, for the "Clear downloaded firmware" line. */
    fun firmwareOnPhone(summary: CacheSummary): String = when (summary.count) {
        0 -> "No firmware is kept on this phone."
        1 -> "1 firmware image is kept on this phone (${kilobytes(summary.bytes)})."
        else -> "${summary.count} firmware images are kept on this phone (${kilobytes(summary.bytes)})."
    }

    fun kilobytes(bytes: Long): String = String.format(Locale.ROOT, "%,d KB", (bytes + 512) / 1024)

    /** An error from the console or the sign-in, in words. */
    fun describe(e: Throwable): String = when (e) {
        is ApiError, is SignedOutException, is SignInException -> e.message ?: "Something went wrong."
        is SerializationException, is IllegalArgumentException -> "The console's answer could not be read."
        is IOException -> "Could not reach the console. Check the phone's connection."
        else -> e.message ?: e.javaClass.simpleName
    }
}
