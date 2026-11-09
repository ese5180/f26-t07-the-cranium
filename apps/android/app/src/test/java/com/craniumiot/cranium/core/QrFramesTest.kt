package com.craniumiot.cranium.core

import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The camera's frames as Scan board reads them (QrFrames), on frames drawn here of a board's label. */
class QrFramesTest {
    private val link = "https://console.example.test/#/devices/cranium-fe5b26c0c5b1dcd7"

    /** A grey frame of [width] x [height] with a stride of [stride], and a label's code drawn [scale] to a module. */
    private fun frame(text: String, width: Int, height: Int, stride: Int, scale: Int = 6): ByteArray {
        val hints = mapOf(EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M, EncodeHintType.MARGIN to 4)
        val size = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, hints).width
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size * scale, size * scale, hints)
        val luma = ByteArray(stride * height) { 0x60 }
        val left = (width - matrix.width) / 2
        val top = (height - matrix.height) / 2
        for (y in 0 until matrix.height) {
            for (x in 0 until matrix.width) {
                luma[(top + y) * stride + left + x] = if (matrix[x, y]) 0x10 else 0xF0.toByte()
            }
        }
        return luma
    }

    @Test
    fun `a board's code in a frame reads back to its link, and the link opens that board`() {
        val luma = frame(link, 480, 360, 480)
        val text = QrFrames.read(luma, 480, 360)
        assertEquals(link, text)
        assertEquals(BoardLink.Result.Board("cranium-fe5b26c0c5b1dcd7"), BoardLink.thing(text!!, "https://console.example.test"))
    }

    @Test
    fun `rows padded past the frame's width are read as the camera gives them`() {
        // The camera's rows are often longer than the picture is wide; the last row may stop at the width.
        val padded = frame(link, 480, 360, 512)
        assertEquals(link, QrFrames.read(padded.copyOf(512 * 359 + 480), 480, 360, 512))
    }

    @Test
    fun `a frame with no code, or one that is not a frame, reads as nothing`() {
        assertNull(QrFrames.read(ByteArray(320 * 240) { 0x70 }, 320, 240))
        assertNull(QrFrames.read(ByteArray(10), 320, 240))
        assertNull(QrFrames.read(ByteArray(100), 10, 10, 5))
        assertNull(QrFrames.read(ByteArray(0), 0, 0))
    }
}
