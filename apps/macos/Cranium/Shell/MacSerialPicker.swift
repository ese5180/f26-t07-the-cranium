import AppKit

/// The question the page's requestPort comes down to: which USB device is the board. A sheet on the app's
/// window (or a dialog when there is none) with the devices by product name and serial number.
@MainActor
enum MacSerialPicker {
    static func choose(from boards: [SerialBoard]) async -> SerialBoard? {
        guard !boards.isEmpty else { return nil }
        let alert = NSAlert()
        alert.messageText = "Choose the board's USB port"
        alert.informativeText = "The Serial console or Board setup wants to use a board's serial port. Pick the board; the app opens its console port and talks to nothing else."
        alert.addButton(withTitle: "Use This Board")
        alert.addButton(withTitle: "Cancel")
        let popup = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 360, height: 26), pullsDown: false)
        for board in boards {
            let ports = board.ports.count == 1 ? "1 port" : "\(board.ports.count) ports"
            popup.addItem(withTitle: "\(board.title), \(ports)")
        }
        alert.accessoryView = popup
        let response: NSApplication.ModalResponse
        if let window = NSApp.keyWindow ?? NSApp.windows.first(where: \.isVisible) {
            response = await alert.beginSheetModal(for: window)
        } else {
            response = alert.runModal()
        }
        guard response == .alertFirstButtonReturn else { return nil }
        return boards.indices.contains(popup.indexOfSelectedItem) ? boards[popup.indexOfSelectedItem] : nil
    }
}
