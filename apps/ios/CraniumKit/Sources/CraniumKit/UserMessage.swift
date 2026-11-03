import Foundation

/// What the app says, from docs/mobile-apps.md, "What a person does" and "Errors to expect".
public enum UserMessage {
    public static let openWindow = "At the board, hold Button 1 for 5 s and let go. LED1 flashes four times: Bluetooth is open for 2 minutes."
    public static let noBoard = "No board found. Hold Button 1 for 5 s, then look again."
    public static let pairing = "Type the 6-digit passkey into the phone's pairing prompt."
    public static let passkeyOnConsole = "The board is not online, so its passkey is not in the cloud. Read it on the board's serial console: the line [BT] passkey."
    public static let uploadTakes = "Sending the image takes a few minutes. Keep the phone near the board, and the app open."
    public static let pressButton = "At the board, press Button 1 within 2 minutes to install it. Button 2 throws it away."
    public static let afterInstall = "The board restarts and runs the new image on trial. It keeps it once it reaches AWS IoT. Its LEDs and console are the real answer."

    /// Next to the passkey: the board the console says is pairing under this name, so that a person
    /// can notice when it is not the board in front of them.
    public static func boardInConsole(_ thing: String) -> String {
        "Board in the console: \(thing)"
    }

    /// Where the image that is sent came from, and its size.
    public static func origin(of image: ObtainedImage) -> String {
        switch image.origin {
        case .phone:
            return "Already on this phone (\(kilobytes(image.size))), and checked again: nothing to download."
        case .downloaded:
            return "Downloaded from the console just now (\(kilobytes(image.size))), and checked."
        }
    }

    /// The checked images the phone keeps, next to "Clear downloaded firmware".
    public static func firmwareOnPhone(_ summary: CacheSummary) -> String {
        switch summary.count {
        case 0: return "No firmware kept on this phone"
        case 1: return "1 firmware image on this phone, \(kilobytes(summary.bytes))"
        default: return "\(summary.count) firmware images on this phone, \(kilobytes(summary.bytes))"
        }
    }

    /// Rounded to the nearest kilobyte (1024 bytes).
    public static func kilobytes(_ bytes: Int) -> String {
        "\((max(bytes, 0) + 512) / 1024) KB"
    }

    public static func text(for error: Error) -> String {
        switch error {
        case let error as BoardError:
            return board(error)
        case let error as UpdateError:
            return update(error)
        case let error as APIError:
            if error.status == 403 {
                return "\(error.message) Ask an administrator for the role."
            }
            return error.message
        case let error as ImageCheckError:
            return "The image failed its check, so nothing was sent. \(error.errorDescription ?? "")"
        case let error as SendCheckError:
            return error.errorDescription ?? "The console did not clear the image, so nothing was sent."
        case let error as AuthError:
            return error.errorDescription ?? "Sign-in failed."
        case let error as ConfigError:
            return error.errorDescription ?? "The configuration is not usable."
        case let error as URLError:
            return "The console could not be reached: \(error.localizedDescription)"
        default:
            return error.localizedDescription
        }
    }

    private static func board(_ error: BoardError) -> String {
        switch error {
        case .bluetoothUnavailable(let why):
            return why
        case .notFound:
            return noBoard
        case .pairingFailed:
            return "Pairing failed. Open the window again (hold Button 1 for 5 s), and use the new passkey."
        case .refused:
            return "The board refused. Its window may have closed: hold Button 1 for 5 s, and connect again."
        case .uploadRefused:
            return "The board refused the upload. Pick a newer release, or open a new window."
        case .disconnectedDuringUpload:
            return "The board disconnected during the upload. Open a new window and send it again: it starts over."
        case .disconnected:
            return "The board disconnected. Hold Button 1 for 5 s to open a new window, and connect again."
        case .timedOut:
            return "The board did not answer. Hold Button 1 for 5 s to open a new window, and connect again."
        case .noRunningVersion:
            return "The board did not say which version it runs, so nothing can be offered."
        case .failed(let text):
            return text
        }
    }

    private static func update(_ error: UpdateError) -> String {
        switch error {
        case .notNewer(let release, let running):
            return "\(release) is not newer than \(running), which the board runs. Pick a newer release."
        case .alreadySent:
            return "An image has already been sent in this window. Open a new window to send another."
        case .notConnected:
            return "Connect to the board first."
        case .busy:
            return "An upload is already under way."
        }
    }
}
