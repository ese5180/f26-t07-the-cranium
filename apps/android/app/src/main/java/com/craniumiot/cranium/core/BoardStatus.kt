package com.craniumiot.cranium.core

/**
 * The board's own account of an update over Bluetooth: its status characteristic, from firmware
 * 1.14.0 (`firmware/app/src/bt/bt_status.h`). Any phone in range reads it with no pairing while the board
 * is connectable, and gets a notification each time it changes. It carries no secret. A board with older
 * firmware has no such characteristic, and the app follows it as it did before. See docs/mobile-apps.md,
 * "The status characteristic". The iPhone app's CraniumKit/BoardStatus.swift is the same, case for case.
 */
data class BoardStatus(
    val window: Window,
    /** Of the window, of the offer while one waits, or of the advertising after the restart. */
    val secondsLeft: Int,
    val image: Image,
    val refusal: Refusal,
    /** So far while receiving, then the image's size. */
    val imageBytes: Long,
    /** `1.14.1+0`, once the first piece has arrived. */
    val imageVersion: String?,
    val result: Result,
    /** Why the window closed, as the firmware numbers it (`enum bt_ota_closed` + 1), 0 while it is open. */
    val closedReason: Int,
    val running: String,
    val onTrial: Boolean,
    val swap: Swap,
    val lastVia: Via,
    val lastOutcome: Outcome,
    val lastProof: Proof,
    val lastTarget: String?,
    val lastFrom: String?,
    /** The first 8 bytes of the image's own SHA-256, in lower-case hex: of an update over Bluetooth only. */
    val lastHash: String?,
    /** Updates over Bluetooth on this board, the last one included. */
    val lastCount: Int,
    val uptime: Long,
) {
    enum class Window(val code: Int) {
        CLOSED(0),

        /** Advertising for an upload, or connected and not paired yet. */
        OPEN(1),

        /** An authenticated link. */
        LINKED(2),

        /** An image has arrived and waits for a button: the seconds left are the offer's. */
        OFFER(3),

        /** After the restart: status only, for 2 minutes. */
        STATUS(4),
        UNKNOWN(255),
    }

    enum class Image(val code: Int) { NONE(0), RECEIVING(1), RECEIVED(2), VERIFIED(3), REFUSED(4), UNKNOWN(255) }

    enum class Refusal(val code: Int) {
        NONE(0), OLDER(1), NOT_IMAGE_0(2), NO_HEADER(3), TOO_LARGE(4), BAD_SIZES(5),
        INCOMPATIBLE_BOARD(6), INCOMPATIBLE_LAYOUT(7), MALFORMED(8), SWAP_PENDING(9), CANNOT_INSTALL(10),
        UNKNOWN(255),
    }

    /** How the window ended. */
    enum class Result(val code: Int) {
        NONE(0),

        /** Button 1: the board restarts into the bootloader to install it. */
        INSTALLING(1),

        /** Button 2. */
        DISCARDED(2),

        /** Nobody pressed a button in the 2 minutes of the offer, or the window's time ran out. */
        TIMED_OUT(3),
        CLOSED(4),
        UNKNOWN(255),
    }

    /** What the bootloader is to do at the next restart. */
    enum class Swap(val code: Int) { NONE(0), TEST(1), PERMANENT(2), REVERT(3), FAIL(4), UNKNOWN(255) }

    enum class Via(val code: Int) { NONE(0), BLUETOOTH(1), WIFI(2), UNKNOWN(255) }

    /** The last update's outcome, as the board recorded it. */
    enum class Outcome(val code: Int, val word: String) {
        NONE(0, "none"),
        PENDING(1, "pending"),
        KEPT(2, "succeeded"),
        ROLLED_BACK(3, "rolled_back"),
        NOT_INSTALLED(4, "not_installed"),
        TRIAL_LOST(5, "trial_lost"),
        SUPERSEDED(6, "superseded"),
        FLASH_ERROR(7, "flash_error"),
        INCOMPATIBLE_BOARD(8, "incompatible_board"),
        INCOMPATIBLE_LAYOUT(9, "incompatible_layout"),
        FAILED(10, "failed"),
        UNKNOWN(255, "unknown"),
        ;

        /** Over, one way or the other. */
        val isEnd: Boolean get() = this != NONE && this != PENDING && this != UNKNOWN
    }

    enum class Proof(val code: Int) {
        NONE(0), CLOUD(1), PERSON(2), UNKNOWN(255);

        val word: String get() = when (this) {
            CLOUD -> "cloud"
            PERSON -> "person"
            else -> "none"
        }
    }

    /** The two say something different, beyond what counts by itself: the seconds left, the bytes and the uptime. */
    fun isNews(after: BoardStatus?): Boolean {
        if (after == null) return true
        return copy(secondsLeft = 0, imageBytes = 0, uptime = 0) != after.copy(secondsLeft = 0, imageBytes = 0, uptime = 0)
    }

    companion object {
        /**
         * The service the board advertises after the restart that an update over Bluetooth asked for, and
         * that it has in every window. Its one characteristic: read and notify.
         */
        const val SERVICE_UUID = "9112B1B4-2A51-40F0-94D3-A76440F0E6CC"
        const val CHARACTERISTIC_UUID = "9112B1B5-2A51-40F0-94D3-A76440F0E6CC"

        /** The first byte. A payload of another format says nothing that this app can read. */
        const val FORMAT = 1
        const val LENGTH = 64

        /** Reads a payload. Null when it is short, or of a format this app does not know. */
        fun parse(data: ByteArray): BoardStatus? {
            if (data.size < LENGTH || u8(data, 0) != FORMAT) return null
            val hash = (48 until 56).map { u8(data, it) }
            return BoardStatus(
                window = Window.entries.firstOrNull { it.code == u8(data, 1) } ?: Window.UNKNOWN,
                secondsLeft = u16(data, 2),
                image = Image.entries.firstOrNull { it.code == u8(data, 4) } ?: Image.UNKNOWN,
                refusal = Refusal.entries.firstOrNull { it.code == u8(data, 5) } ?: Refusal.UNKNOWN,
                imageBytes = u32(data, 6),
                imageVersion = version(data, 10),
                result = Result.entries.firstOrNull { it.code == u8(data, 18) } ?: Result.UNKNOWN,
                closedReason = u8(data, 19),
                running = version(data, 20) ?: "0.0.0+0",
                onTrial = u8(data, 28) and 1 != 0,
                swap = Swap.entries.firstOrNull { it.code == (u8(data, 28) shr 1) and 7 } ?: Swap.UNKNOWN,
                lastVia = Via.entries.firstOrNull { it.code == u8(data, 29) } ?: Via.UNKNOWN,
                lastOutcome = Outcome.entries.firstOrNull { it.code == u8(data, 30) } ?: Outcome.UNKNOWN,
                lastProof = Proof.entries.firstOrNull { it.code == u8(data, 31) } ?: Proof.UNKNOWN,
                lastTarget = version(data, 32),
                lastFrom = version(data, 40),
                lastHash = if (hash.any { it != 0 }) hash.joinToString("") { "%02x".format(it) } else null,
                lastCount = u16(data, 56),
                uptime = u32(data, 58),
            )
        }

        /** Why the board refused an image, in words. */
        fun words(refusal: Refusal): String = when (refusal) {
            Refusal.OLDER -> "It is not newer than what the board runs."
            Refusal.NOT_IMAGE_0 -> "It is not for image 0."
            Refusal.NO_HEADER -> "It does not start with an image header."
            Refusal.TOO_LARGE -> "It would reach the end of the board's slot."
            Refusal.BAD_SIZES -> "Its header claims more than the file holds."
            Refusal.INCOMPATIBLE_BOARD -> "It is for another kind of board."
            Refusal.INCOMPATIBLE_LAYOUT -> "It is for another flash layout."
            Refusal.MALFORMED -> "Its signed metadata is malformed, or it could not be read back."
            Refusal.SWAP_PENDING -> "The bootloader has a swap to do already."
            Refusal.CANNOT_INSTALL -> "The board could not record it or ask for the swap."
            Refusal.NONE, Refusal.UNKNOWN -> "The board did not say why."
        }

        private fun u8(b: ByteArray, at: Int): Int = b[at].toInt() and 0xFF

        private fun u16(b: ByteArray, at: Int): Int = u8(b, at) or (u8(b, at + 1) shl 8)

        private fun u32(b: ByteArray, at: Int): Long = u16(b, at).toLong() or (u16(b, at + 2).toLong() shl 16)

        private fun version(b: ByteArray, at: Int): String? {
            if ((at until at + 8).all { b[it].toInt() == 0 }) return null
            return "${u8(b, at)}.${u8(b, at + 1)}.${u16(b, at + 2)}+${u32(b, at + 4)}"
        }
    }
}
