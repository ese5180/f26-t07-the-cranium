import Foundation
import IOKit.pwr_mgt

/// Keeps the Mac and its display awake while the app is carrying a transfer (a Bluetooth update, a board's
/// serial port): an IOKit power assertion, the desktop app's powerSaveBlocker. Released when told, and when
/// the app ends.
final class MacKeepAwake {
    private var assertion = IOPMAssertionID(0)
    private(set) var isHeld = false

    func set(_ on: Bool) {
        if on, !isHeld {
            let made = IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
                                                   IOPMAssertionLevel(kIOPMAssertionLevelOn),
                                                   "Cranium is carrying an update or a board's serial port" as CFString, &assertion)
            isHeld = made == kIOReturnSuccess
        } else if !on, isHeld {
            IOPMAssertionRelease(assertion)
            assertion = IOPMAssertionID(0)
            isHeld = false
        }
    }

    deinit {
        set(false)
    }
}
