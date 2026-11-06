import Foundation

/// How long the Mac app may be away before Touch ID is asked again (docs/mac-app.md, "Touch ID"). On a
/// Mac, "away" is another app in front, or the Mac asleep; the phones have a fixed 5 minutes
/// (`BiometricLock.relockAfter`).
public enum RelockChoice: String, CaseIterable, Identifiable, Sendable {
    case immediately
    case oneMinute
    case fiveMinutes
    case fifteenMinutes
    case oneHour

    public var id: String { rawValue }

    public var interval: TimeInterval {
        switch self {
        case .immediately: return 0
        case .oneMinute: return 60
        case .fiveMinutes: return 5 * 60
        case .fifteenMinutes: return 15 * 60
        case .oneHour: return 3600
        }
    }

    public var title: String {
        switch self {
        case .immediately: return "Immediately"
        case .oneMinute: return "After 1 minute"
        case .fiveMinutes: return "After 5 minutes"
        case .fifteenMinutes: return "After 15 minutes"
        case .oneHour: return "After 1 hour"
        }
    }
}

/// The Mac app's lock settings, beside the switch itself (which is BiometricLock's, as on the phones).
public struct MacLockPreferences: Equatable, Sendable {
    public static let relockKey = "cranium.mac.relock"
    public static let sleepKey = "cranium.mac.lockWhenMacSleeps"

    /// How long away before it asks again. The phones' 5 minutes unless chosen.
    public var relock: RelockChoice
    /// Lock as soon as the Mac sleeps or its screen locks, however long the time above.
    public var lockWhenMacSleeps: Bool

    public init(relock: RelockChoice = .fiveMinutes, lockWhenMacSleeps: Bool = true) {
        self.relock = relock
        self.lockWhenMacSleeps = lockWhenMacSleeps
    }

    public static func load(_ defaults: UserDefaults = .standard) -> MacLockPreferences {
        MacLockPreferences(
            relock: defaults.string(forKey: relockKey).flatMap(RelockChoice.init(rawValue:)) ?? .fiveMinutes,
            lockWhenMacSleeps: defaults.object(forKey: sleepKey) as? Bool ?? true
        )
    }

    public func save(_ defaults: UserDefaults = .standard) {
        defaults.set(relock.rawValue, forKey: Self.relockKey)
        defaults.set(lockWhenMacSleeps, forKey: Self.sleepKey)
    }
}

/// The Mac's words about Touch ID, beside `BiometricWords` (which the phones share).
public enum MacLockWords {
    public static let requireTouchID = "Require Touch ID"
    public static let relock = "Ask again"
    public static let lockWhenMacSleeps = "Lock when the Mac sleeps or its screen locks"
    /// A Mac with no Touch ID (most desktop Macs without a Magic Keyboard with Touch ID).
    public static let noTouchID = "This Mac has no Touch ID, so Cranium cannot be locked with it. Without it, the sign-in is kept for 60 minutes after you sign in, as on a phone without Face ID."
    #if os(macOS)
    /// Who holds the saved sign-in, in the Settings' footnote.
    public static func guarded(_ guarded: SecretGuard) -> String {
        switch guarded {
        case .keychain:
            return "The Keychain itself opens the saved sign-in only for the fingers enrolled on this Mac now."
        case .app:
            return "This build is not signed with a team, so the Keychain cannot hold Touch ID itself: Cranium asks for Touch ID before it reads the saved sign-in. A build signed with your team (apps/macos/README.md) lets the Keychain enforce it."
        }
    }
    #endif
}
