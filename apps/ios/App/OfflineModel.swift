import CraniumBLE
import CraniumKit
import Foundation

/// Offline mode: the phone talks to a board directly over Bluetooth, with no Wi-Fi or cloud
/// (firmware 1.19.0). Scan for boards whose window is open, pair with the board's own passkey, read its
/// status, and accept the update that waits. Nothing here uses the internet or the console. See
/// docs/mobile-apps.md, "Offline mode".
@MainActor
final class OfflineModel: ObservableObject {
    enum Stage: Equatable {
        case scanning
        case linked(String)
    }

    @Published private(set) var stage: Stage = .scanning
    @Published private(set) var boards: [DiscoveredBoard] = []
    @Published private(set) var radioProblem: String?
    @Published private(set) var link: OfflineLink.State = .connecting
    /// Set when the person has been asked whether to accept, and answers.
    @Published var confirming = false
    @Published private(set) var accepted = false

    private var radioIfMade: BoardRadio?
    private var current: OfflineLink?

    /// Made when first needed: making its radio is what has iOS ask for Bluetooth.
    private var radio: BoardRadio {
        if let radio = radioIfMade { return radio }
        let radio = BoardRadio()
        radio.onChange = { [weak self, weak radio] in
            guard let self, let radio else { return }
            self.boards = radio.boards
            self.radioProblem = radio.state.problem
        }
        radioIfMade = radio
        return radio
    }

    func start() {
        stage = .scanning
        accepted = false
        radio.startScanning()
    }

    func connect(_ board: DiscoveredBoard) {
        guard let made = radio.offlineLink(for: board) else { return }
        current = made
        link = .connecting
        accepted = false
        stage = .linked(board.name)
        made.onState = { [weak self] state in
            guard let self else { return }
            if state == .accepted { self.accepted = true }
            self.link = state
        }
        made.connect()
    }

    /// The person confirmed the version they were shown.
    func accept(version: String) {
        confirming = false
        current?.accept(version: version)
    }

    /// Back to the list of boards.
    func back() {
        current?.onState = nil
        current?.close()
        current = nil
        start()
    }

    func close() {
        current?.onState = nil
        current?.close()
        current = nil
        radioIfMade?.stopScanning()
        stage = .scanning
    }
}
