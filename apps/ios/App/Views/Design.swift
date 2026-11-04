import CraniumKit
import SwiftUI

// The app's look: iOS's own grouped lists and rows, on the console's paper, with the console's
// colours kept for states. SF for words; monospace only for versions, board names and hashes, one
// size each. Explanations live in Help, reached with the (?) button.

extension Typeface {
    /// A release version: `1.11.4+0`.
    static let version = Font.system(.body, design: .monospaced)
    /// A board's thing name: `cranium-3f2a…`.
    static let thing = Font.system(.footnote, design: .monospaced)
    /// A digest, a deployment or token id.
    static let hash = Font.system(.caption, design: .monospaced)
}

/// A screen as an inset-grouped list on the console's paper.
struct ListScreen<Content: View>: View {
    @Environment(\.theme) private var theme
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        List {
            content
                .listRowBackground(theme.surface)
        }
        #if os(iOS)
        .listStyle(.insetGrouped)
        #endif
        .scrollContentBackground(.hidden)
        .background(theme.paper.ignoresSafeArea())
        .foregroundStyle(theme.ink)
    }
}

/// A board as people know it in a row: its device ID, and its thing name small under it.
struct BoardLabel: View {
    @Environment(\.theme) private var theme
    let thing: String
    let name: String?

    init(_ thing: String, name: String?) {
        self.thing = thing
        self.name = name
    }

    init(_ device: Device) {
        self.init(device.thing, name: device.name)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let name {
                Text(verbatim: name).font(.body.weight(.semibold))
            }
            Text(verbatim: thing)
                .font(Typeface.thing)
                .foregroundStyle(name == nil ? theme.ink : theme.ink3)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(name.map { "\($0), \(thing)" } ?? thing)
    }
}

/// A version in its one monospace size.
struct VersionText: View {
    let version: String

    init(_ version: String) {
        self.version = version
    }

    var body: some View {
        Text(verbatim: version).font(Typeface.version)
    }
}

/// A small status: the tone's colour on the icon and the word, nothing else.
struct StatusText: View {
    @Environment(\.theme) private var theme
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

    init(_ words: UpdateWords) {
        self.init(words.tone, words.icon, words.title)
    }

    var body: some View {
        Label {
            Text(text).foregroundStyle(tone == .idle || tone == .wait ? theme.ink2 : theme.ink)
        } icon: {
            Image(systemName: Icon.symbol(icon)).foregroundStyle(theme.tone(tone))
        }
        .font(.subheadline)
    }
}

/// Online, offline, restarting or never connected, as a small pill.
struct OnlinePill: View {
    @Environment(\.theme) private var theme
    let device: Device

    var body: some View {
        let (tone, text): (Tone, String) = Words.isRestarting(device) ? (.idle, "Restarting")
            : device.online ? (.good, "Online") : device.lastSeen == nil ? (.idle, "Never connected") : (.idle, "Offline")
        HStack(spacing: 5) {
            Circle().fill(tone == .good ? theme.good : theme.ink3).frame(width: 7, height: 7)
            Text(text).font(.caption.weight(.semibold))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(tone == .good ? theme.goodWash : theme.well, in: Capsule())
        .accessibilityElement(children: .combine)
    }
}

/// Progress of a download, in the console's "at work" colour.
struct ProgressBar: View {
    @Environment(\.theme) private var theme
    let percent: Int
    var label = "Download"

    var body: some View {
        ProgressView(value: Double(min(max(percent, 0), 100)), total: 100)
            .tint(theme.work)
            .accessibilityLabel(label)
            .accessibilityValue("\(percent) percent")
    }
}

/// One line and one action: for an empty list, a load in progress, or a failure.
struct StateRow: View {
    @Environment(\.theme) private var theme
    enum Kind { case loading, empty, failed }
    let kind: Kind
    let text: String
    var action: (title: String, run: () -> Void)?

    var body: some View {
        HStack(spacing: 10) {
            switch kind {
            case .loading: ProgressView()
            case .failed: Image(systemName: "exclamationmark.triangle").foregroundStyle(theme.bad)
            case .empty: EmptyView()
            }
            Text(text).foregroundStyle(kind == .failed ? theme.ink : theme.ink2).font(.subheadline)
            Spacer(minLength: 8)
            if let action {
                Button(action.title, action: action.run).font(.subheadline.weight(.semibold))
            }
        }
    }
}

/// Said only when what is shown is old, or could not be read again: a quiet line, and Retry.
struct StaleNote: View {
    @Environment(\.theme) private var theme
    let loadedAt: Date?
    let error: Error?
    /// How often it is read; older than three times this, or two minutes, is old.
    var every: TimeInterval = Words.idleRefresh
    let retry: () -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 15)) { context in
            if let words = words(now: context.date) {
                HStack(spacing: 8) {
                    Image(systemName: error != nil ? "exclamationmark.icloud" : "clock.arrow.circlepath")
                        .foregroundStyle(error != nil ? theme.warn : theme.ink3)
                    Text(words).font(.footnote).foregroundStyle(theme.ink2)
                    Spacer(minLength: 8)
                    Button("Retry", action: retry).font(.footnote.weight(.semibold))
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func words(now: Date) -> String? {
        if let error {
            let what = Words.sentence(Words.plainMessage(error))
            if let loadedAt { return "Couldn't refresh: showing what was read \(Words.timeAgo(ConsoleTime.text(loadedAt), now: now)). \(what)" }
            return "Couldn't load. \(what)"
        }
        guard let loadedAt, now.timeIntervalSince(loadedAt) > max(3 * every, 120) else { return nil }
        return "Updated \(Words.timeAgo(ConsoleTime.text(loadedAt), now: now))"
    }

    /// Whether there is anything to say.
    static func shows(loadedAt: Date?, error: Error?, every: TimeInterval = Words.idleRefresh) -> Bool {
        if error != nil { return true }
        guard let loadedAt else { return false }
        return Date().timeIntervalSince(loadedAt) > max(3 * every, 120)
    }
}

/// The Help topics, from the app's copy of apps/shared/help.json.
enum HelpLibrary {
    static let book: HelpBook? = try? HelpBook.load(from: .main)
}

/// The (?) button: the Help topic about what is on the screen, in a sheet.
struct HelpButton: View {
    let topic: String
    @State private var open = false

    var body: some View {
        Button {
            open = true
        } label: {
            Image(systemName: "questionmark.circle")
        }
        .accessibilityLabel("Help")
        .sheet(isPresented: $open) {
            NavigationStack {
                HelpTopicView(id: topic)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) { Button("Done") { open = false } }
                    }
            }
        }
    }
}

extension View {
    /// The (?) button in the toolbar, for a Help topic.
    func helpButton(_ topic: String) -> some View {
        toolbar {
            ToolbarItem(placement: .primaryAction) { HelpButton(topic: topic) }
        }
    }

    /// A screen's title, large, without the console's own title colours.
    func screenTitle(_ title: String, large: Bool = true) -> some View {
        navigationTitle(title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(large ? .large : .inline)
            #endif
    }
}

/// A label and its value on one row, the value quiet; or under it when it is long.
struct ValueRow<Value: View>: View {
    @Environment(\.theme) private var theme
    let label: String
    let value: Value

    init(_ label: String, @ViewBuilder value: () -> Value) {
        self.label = label
        self.value = value()
    }

    var body: some View {
        LabeledContent {
            value.foregroundStyle(theme.ink2).multilineTextAlignment(.trailing)
        } label: {
            Text(label)
        }
    }
}

extension ValueRow where Value == Text {
    init(_ label: String, _ value: String) {
        self.init(label) { Text(value) }
    }
}

/// The one prominent action of a screen, full width, in its own row.
struct PrimaryButton: View {
    @Environment(\.theme) private var theme
    let title: String
    let systemImage: String?
    var role: ButtonRole? = nil
    var busy = false
    let action: () -> Void

    init(_ title: String, systemImage: String? = nil, role: ButtonRole? = nil, busy: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.systemImage = systemImage
        self.role = role
        self.busy = busy
        self.action = action
    }

    var body: some View {
        Button(role: role, action: action) {
            HStack(spacing: 8) {
                if busy { ProgressView().tint(theme.onAccent) }
                if let systemImage, !busy { Image(systemName: systemImage) }
                Text(title)
            }
            .font(.body.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 34)
        }
        .buttonStyle(.borderedProminent)
        .tint(role == .destructive ? theme.badFill : theme.accent)
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets())
    }
}

/// A release in a list: its version, and its note (two lines at most) or when it was uploaded.
struct ReleaseLine: View {
    @Environment(\.theme) private var theme
    let release: FirmwareRelease
    var newest = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                VersionText(release.version).foregroundStyle(release.isActive ? theme.ink : theme.ink3)
                if !release.isActive {
                    Text("Revoked").font(.caption.weight(.semibold)).foregroundStyle(theme.bad)
                } else if newest {
                    Text("Newest").font(.caption.weight(.semibold)).foregroundStyle(theme.good)
                }
                if Words.revocationState(release) == .incomplete {
                    Image(systemName: "exclamationmark.triangle").font(.caption).foregroundStyle(theme.warn)
                        .accessibilityLabel("Revocation incomplete")
                }
            }
            Text(release.notes ?? "Uploaded \(Words.timeAgo(release.uploadedAt, now: Date()))")
                .font(.footnote).foregroundStyle(theme.ink3).lineLimit(2).truncationMode(.tail)
        }
        .accessibilityElement(children: .combine)
    }
}
