package com.craniumiot.cranium.ble

import android.bluetooth.BluetoothDevice
import android.content.Context
import com.craniumiot.cranium.core.ImageSlot
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import no.nordicsemi.android.mcumgr.McuMgrCallback
import no.nordicsemi.android.mcumgr.McuMgrTransport
import no.nordicsemi.android.mcumgr.ble.McuMgrBleTransport
import no.nordicsemi.android.mcumgr.exception.McuMgrException
import no.nordicsemi.android.mcumgr.managers.ImageManager
import no.nordicsemi.android.mcumgr.response.img.McuMgrImageStateResponse
import no.nordicsemi.android.mcumgr.transfer.TransferController
import no.nordicsemi.android.mcumgr.transfer.UploadCallback
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * One Bluetooth session with a board, through Nordic's MCUmgr library. It does only what the board
 * allows (docs/mobile-apps.md, "Bluetooth"): `image list`, and a plain upload of image 0. No test,
 * no confirm, no erase, no reset: the board refuses those, and an upload is installed by a person
 * pressing Button 1 at the board.
 *
 * The link has to be paired before the board answers anything. The phone's OS asks for the passkey
 * itself when the library first touches the SMP characteristic, during [connect].
 */
class BoardSession(context: Context, device: BluetoothDevice, onLinkLost: () -> Unit) {
    private val transport = McuMgrBleTransport(context.applicationContext, device)
    private val images = ImageManager(transport)
    private var upload: TransferController? = null

    private val observer = object : McuMgrTransport.ConnectionObserver {
        override fun onConnected() = Unit

        override fun onDisconnected() = onLinkLost()
    }

    init {
        transport.addObserver(observer)
    }

    /** Connect, pair (the phone asks for the passkey) and set up the SMP characteristic. */
    suspend fun connect(): Unit = suspendCancellableCoroutine { continuation ->
        transport.connect(object : McuMgrTransport.ConnectionCallback {
            override fun onConnected() {
                if (continuation.isActive) continuation.resume(Unit)
            }

            override fun onDeferred() {
                if (continuation.isActive) continuation.resume(Unit)
            }

            override fun onError(t: Throwable) {
                if (continuation.isActive) continuation.resumeWithException(t)
            }
        })
    }

    /** `image list`: what is in each slot. Slot 0 of image 0 is what runs. */
    suspend fun readImages(): List<ImageSlot> = suspendCancellableCoroutine { continuation ->
        images.list(object : McuMgrCallback<McuMgrImageStateResponse> {
            override fun onResponse(response: McuMgrImageStateResponse) {
                val slots = response.images.orEmpty().map {
                    ImageSlot(
                        image = it.image,
                        slot = it.slot,
                        version = it.version.orEmpty(),
                        active = it.active,
                        confirmed = it.confirmed,
                        pending = it.pending,
                        permanent = it.permanent,
                    )
                }
                if (continuation.isActive) continuation.resume(slots)
            }

            override fun onError(error: McuMgrException) {
                if (continuation.isActive) continuation.resumeWithException(error)
            }
        })
    }

    /**
     * Upload [data] as image 0, and nothing after it. [onProgress] gets the bytes the board has
     * taken so far; it is called on a background thread.
     */
    suspend fun upload(data: ByteArray, onProgress: (sent: Int, total: Int) -> Unit): Unit =
        suspendCancellableCoroutine { continuation ->
            val controller = images.imageUpload(data, 0, object : UploadCallback {
                override fun onUploadProgressChanged(current: Int, total: Int, timestamp: Long) {
                    onProgress(current, total)
                }

                override fun onUploadFailed(error: McuMgrException) {
                    if (continuation.isActive) continuation.resumeWithException(error)
                }

                override fun onUploadCanceled() {
                    if (continuation.isActive) continuation.resumeWithException(CancellationException("Upload cancelled"))
                }

                override fun onUploadCompleted() {
                    if (continuation.isActive) continuation.resume(Unit)
                }
            })
            upload = controller
            continuation.invokeOnCancellation { controller.cancel() }
        }

    /** Stop whatever is going on and disconnect. No disconnection callback follows. */
    fun close() {
        transport.removeObserver(observer)
        upload?.cancel()
        upload = null
        transport.release()
    }
}
