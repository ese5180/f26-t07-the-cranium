package com.craniumiot.cranium.core

import com.google.zxing.BinaryBitmap
import com.google.zxing.ChecksumException
import com.google.zxing.DecodeHintType
import com.google.zxing.FormatException
import com.google.zxing.NotFoundException
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader

/**
 * The QR code in one frame of the camera, for Scan board (shell/BoardScanner.kt): ZXing's QR reader on the
 * frame's brightness (the Y plane), which is all a QR code needs. Null when the frame holds none, or one
 * that does not read. Plain Kotlin and ZXing, so the tests run it on frames they draw.
 */
object QrFrames {
    private val hints = mapOf(DecodeHintType.TRY_HARDER to true, DecodeHintType.CHARACTER_SET to "UTF-8")

    /**
     * [luma] holds [height] rows of [rowStride] bytes, each with [width] bytes of brightness at its start
     * (the last row may stop at [width]).
     */
    fun read(luma: ByteArray, width: Int, height: Int, rowStride: Int = width): String? {
        if (width <= 0 || height <= 0 || rowStride < width || luma.size < rowStride * (height - 1) + width) return null
        val packed = if (rowStride == width) {
            luma
        } else {
            ByteArray(width * height).also { out ->
                for (row in 0 until height) System.arraycopy(luma, row * rowStride, out, row * width, width)
            }
        }
        val source = PlanarYUVLuminanceSource(packed, width, height, 0, 0, width, height, false)
        return try {
            QRCodeReader().decode(BinaryBitmap(HybridBinarizer(source)), hints).text
        } catch (e: NotFoundException) {
            null
        } catch (e: ChecksumException) {
            null
        } catch (e: FormatException) {
            null
        }
    }
}
