import CraniumKit
import SwiftUI

/// What the lock screen needs of either side (AppModel, CustomerModel), as LockScreen.swift has it
/// on the iPhone. CustomerModel.swift declares its own conformance.
protocol LockingModel: ObservableObject {
    var biometry: Biometry? { get }
    var lockMessage: String? { get }
    var unlocking: Bool { get }
    var cover: AppModel.Cover? { get }
    var lockSubtitle: String { get }
    var lockHelpTopic: String? { get }
    func unlock() async
    func signInWithPassword() async
}

extension AppModel: LockingModel {
    var lockSubtitle: String { "Firmware console" }
    var lockHelpTopic: String? { "biometric-sign-in" }
}

extension Tone {
    /// The system's colours, so that the Mac's light and dark appearances and its accessibility
    /// settings (Increase Contrast) apply.
    var color: Color {
        switch self {
        case .act: return .accentColor
        case .wait: return .orange
        case .live: return .blue
        case .good: return .green
        case .warn: return .orange
        case .bad: return .red
        case .idle: return .secondary
        }
    }
}

/// A status in words with its icon, in its tone: "Online", "Update failed".
struct StatusLabel: View {
    let tone: Tone
    let icon: String
    let text: String

    init(_ tone: Tone, _ icon: String, _ text: String) {
        self.tone = tone
        self.icon = icon
        self.text = text
    }

    init(_ look: Look) {
        self.init(look.tone, look.icon, look.label)
    }

    var body: some View {
        Label {
            Text(text)
        } icon: {
            Image(systemName: Icon.symbol(icon)).foregroundStyle(tone.color)
        }
        .accessibilityElement(children: .combine)
    }
}

/// A firmware version, in the monospaced digits the console sets versions in.
struct VersionText: View {
    let version: String

    init(_ version: String) {
        self.version = version
    }

    var body: some View {
        Text(version).font(.body.monospacedDigit()).textSelection(.enabled)
    }
}

/// A board's name over its thing name, as the console names boards.
struct BoardTitle: View {
    let thing: String
    let name: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(name ?? Words.shortThing(thing))
            if name != nil {
                Text(thing).font(.caption.monospaced()).foregroundStyle(.secondary)
            }
        }
    }
}

/// Loading, empty and failed states of a page, in the middle of it.
struct PageState: View {
    enum Kind {
        case loading
        case empty
        case failed
    }

    let kind: Kind
    let text: String
    var retry: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: 12) {
            switch kind {
            case .loading:
                ProgressView()
            case .empty:
                Image(systemName: "tray").font(.largeTitle).foregroundStyle(.secondary)
            case .failed:
                Image(systemName: "exclamationmark.triangle").font(.largeTitle).foregroundStyle(.orange)
            }
            Text(text).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 420)
            if let retry {
                Button("Try Again", action: retry)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// When a list was last read, and whether reading it again failed: the console's "stale" line.
struct FreshnessFooter: View {
    @EnvironmentObject private var session: MacSession
    let loadedAt: Date?
    let error: Error?

    var body: some View {
        HStack(spacing: 6) {
            if let error {
                Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange)
                Text(Words.plainMessage(error)).lineLimit(1)
            } else if let loadedAt {
                Image(systemName: session.liveState == .live ? "bolt.fill" : "clock").foregroundStyle(.secondary)
                Text(session.liveState == .live ? "Live · read \(Words.timeAgo(iso(loadedAt), now: Date()))"
                                                : "Read \(Words.timeAgo(iso(loadedAt), now: Date()))")
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    private func iso(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }
}

/// Reads a page now, again every `interval()` seconds while it is shown, on each live change, and in
/// full on ⌘R. The iPhone's Poll, with the live socket's signal (docs/live.md).
struct Refreshing: ViewModifier {
    @EnvironmentObject private var session: MacSession
    let interval: () -> TimeInterval
    /// Whether a live change is about this page; nil for every change.
    var concerns: ((LiveChange) -> Bool)? = nil
    let refresh: (Bool) async -> Void

    func body(content: Content) -> some View {
        content
            .task {
                await refresh(true)
                while !Task.isCancelled {
                    let wait = interval()
                    try? await Task.sleep(nanoseconds: UInt64((wait > 0 ? wait : 5) * 1_000_000_000))
                    guard !Task.isCancelled else { return }
                    if wait > 0 { await refresh(false) }
                }
            }
            .onChange(of: session.changes) { _ in
                if let change = session.lastChange, let concerns, !concerns(change) { return }
                Task { await refresh(false) }
            }
            .onChange(of: session.refreshes) { _ in
                Task { await refresh(true) }
            }
    }
}

extension View {
    func refreshing(every interval: @escaping () -> TimeInterval, concerns: ((LiveChange) -> Bool)? = nil,
                    _ refresh: @escaping (Bool) async -> Void) -> some View {
        modifier(Refreshing(interval: interval, concerns: concerns, refresh: refresh))
    }

    /// A page's own title in the window's toolbar, and its live state at the trailing edge.
    func pageToolbar(_ title: String, subtitle: String? = nil) -> some View {
        modifier(PageToolbar(title: title, subtitle: subtitle))
    }
}

struct PageToolbar: ViewModifier {
    @EnvironmentObject private var session: MacSession
    let title: String
    let subtitle: String?

    func body(content: Content) -> some View {
        content
            .navigationTitle(title)
            .navigationSubtitle(subtitle ?? "")
            .toolbar {
                ToolbarItem(placement: .automatic) {
                    LiveBadge(state: session.liveState)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        session.refreshNow()
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    .help("Read this page again (⌘R)")
                }
            }
    }
}

/// "Live" while the socket is up; otherwise how the page is kept fresh.
struct LiveBadge: View {
    let state: LiveClient.State

    var body: some View {
        switch state {
        case .live:
            Label("Live", systemImage: "bolt.fill")
                .labelStyle(.titleAndIcon)
                .foregroundStyle(.green)
                .help("A change on a board shows here within about a second (docs/live.md).")
        case .connecting:
            Label("Connecting", systemImage: "bolt.horizontal")
                .labelStyle(.titleAndIcon)
                .foregroundStyle(.secondary)
        case .waiting, .off:
            Label("Refreshing", systemImage: "clock")
                .labelStyle(.titleAndIcon)
                .foregroundStyle(.secondary)
                .help("No live connection just now: the page is read again on a timer.")
        }
    }
}

/// A row of a label and its value, for detail panes.
struct FactRow: View {
    let label: String
    let value: String
    var mono = false

    init(_ label: String, _ value: String, mono: Bool = false) {
        self.label = label
        self.value = value
        self.mono = mono
    }

    var body: some View {
        LabeledContent(label) {
            Text(value)
                .font(mono ? .body.monospaced() : .body)
                .textSelection(.enabled)
                .multilineTextAlignment(.trailing)
        }
    }
}

/// A short message at the foot of a window: "Touch ID is on."
struct Toast: View {
    let text: String?

    var body: some View {
        if let text {
            Text(text)
                .font(.callout.weight(.medium))
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(.regularMaterial, in: Capsule())
                .shadow(radius: 4, y: 1)
                .padding(.bottom, 16)
                .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}
