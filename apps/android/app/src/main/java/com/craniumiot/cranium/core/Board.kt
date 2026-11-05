package com.craniumiot.cranium.core

/** What the board says about one slot in answer to `image list`. */
data class ImageSlot(
    val image: Int,
    val slot: Int,
    val version: String,
    val active: Boolean,
    val confirmed: Boolean,
    val pending: Boolean,
    /** Marked to stay after the next restart (MCUmgr's `permanent`). */
    val permanent: Boolean = false,
)

object BoardImages {
    /** What runs: image 0, slot 0. Its version decides what the board takes. */
    fun running(slots: List<ImageSlot>): ImageSlot? = slots.firstOrNull { it.image == 0 && it.slot == 0 }
}

/** The Bluetooth details of the board (docs/mobile-apps.md, "Bluetooth"). */
object BoardBluetooth {
    const val SMP_SERVICE_UUID = "8D53DC1D-1DB7-4CD3-868B-8A527460AA84"
    const val SMP_CHARACTERISTIC_UUID = "DA2E7828-FBCE-4E01-AE9E-261174997C48"

    private val NAME = Regex("^Cranium-[0-9A-F]{4}$")
    private val THING = Regex("^cranium-[0-9a-f]{16}$")

    /** Whether [name] is what a board advertises: `Cranium-` and four upper-case hex digits. */
    fun isBoardName(name: String?): Boolean = name != null && NAME.matches(name)

    /** Whether [thing] is a board's name in the console (its AWS IoT thing): `cranium-` and 16 hex digits. */
    fun isThing(thing: String?): Boolean = thing != null && THING.matches(thing)
}
