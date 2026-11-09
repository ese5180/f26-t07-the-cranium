import Foundation

/// Why the iPhone app has no Board setup (docs/new-board-setup.md, "From the console: Board setup"): the
/// console's setup.js APP_WORDS, held to them by ParityTests. Board setup talks to a board over its USB serial
/// port, which iOS gives no app.
public enum BoardSetupWords {
    public static let title = "Board setup needs a computer"
    public static let ios =
        "An iPhone cannot open a board’s USB serial port: iOS gives apps no way to a USB serial device, and Safari " +
        "has no Web Serial. Set the board up in the Windows or Linux desktop app, or in Chrome or Edge on a computer."
}
