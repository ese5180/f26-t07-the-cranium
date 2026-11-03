import CraniumKit
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

// The pieces every screen uses, drawn as the website draws them (app.css): heavy rules and open
// columns rather than boxes, one ink panel per screen for what matters most, badges with an icon
// and a word so that no state is told by colour alone.

/// A screen of the console: paper behind it, its pieces stacked with room between them.
struct Page<Content: View>: View {
    @Environment(\.theme) private var theme
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                content
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .background(theme.paper.ignoresSafeArea())
        .foregroundStyle(theme.ink)
    }
}

/// What a screen is about, under its title, and how fresh it is.
struct PageHead: View {
    @Environment(\.theme) private var theme
    var eyebrow: String? = nil
    var lede: String? = nil
    var meta: [String] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let eyebrow { Eyebrow(eyebrow) }
            if let lede {
                Text(lede)
                    .font(Typeface.body)
                    .foregroundStyle(theme.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !meta.isEmpty {
                Text(meta.joined(separator: " · "))
                    .font(Typeface.small)
                    .foregroundStyle(theme.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Small capitals over a section.
struct Eyebrow: View {
    @Environment(\.theme) private var theme
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text.uppercased())
            .font(Typeface.eyebrow)
            .tracking(0.9)
            .foregroundStyle(theme.ink3)
            .accessibilityAddTraits(.isHeader)
    }
}

/// A section of a screen: a heavy rule and a heading, no box.
struct Card<Content: View, More: View>: View {
    @Environment(\.theme) private var theme
    let title: String?
    let more: More
    let content: Content

    init(_ title: String? = nil, @ViewBuilder more: () -> More, @ViewBuilder content: () -> Content) {
        self.title = title
        self.more = more()
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if title != nil || More.self != EmptyView.self {
                HStack(alignment: .firstTextBaseline) {
                    if let title { Eyebrow(title) }
                    Spacer(minLength: 8)
                    more
                        .font(Typeface.small.weight(.semibold))
                }
            }
            content
        }
        .padding(.top, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) {
            Rectangle().fill(theme.rule).frame(height: 2)
        }
    }
}

extension Card where More == EmptyView {
    init(_ title: String? = nil, @ViewBuilder content: () -> Content) {
        self.init(title, more: { EmptyView() }, content: content)
    }
}

/// The ink panel: dark in both themes, one step above a dark page with the heaviest rule on it.
struct Panel<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        let theme = Theme.panel
        VStack(alignment: .leading, spacing: 18) {
            content
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.surface)
        .overlay(alignment: .top) {
            if scheme == .dark { Rectangle().fill(theme.ink).frame(height: 3) }
        }
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .foregroundStyle(theme.ink)
        .environment(\.theme, theme)
    }
}

/// A state as a badge: an icon and a word on the tone's wash.
struct Badge: View {
    @Environment(\.theme) private var theme
    let tone: Tone
    let icon: String
    let label: String

    init(_ look: Look) {
        tone = look.tone
        icon = look.icon
        label = look.label
    }

    init(_ tone: Tone, _ icon: String, _ label: String) {
        self.tone = tone
        self.icon = icon
        self.label = label
    }

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: Icon.symbol(icon))
                .font(.caption2.weight(.bold))
                .foregroundStyle(tone == .idle || tone == .wait ? theme.ink2 : theme.tone(tone))
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(tone == .idle ? theme.ink2 : theme.ink)
                .lineLimit(2)
        }
        .padding(.vertical, 3)
        .padding(.leading, 6)
        .padding(.trailing, 9)
        .background(theme.wash(tone), in: RoundedRectangle(cornerRadius: 4, style: .continuous))
        .overlay {
            if tone == .idle {
                RoundedRectangle(cornerRadius: 4, style: .continuous).stroke(theme.lineStrong, lineWidth: 1)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// A short tag beside a version: "On trial", "Not a registered release".
struct Tag: View {
    @Environment(\.theme) private var theme
    let text: String
    var tone: Tone = .idle

    var body: some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .foregroundStyle(tone == .idle ? theme.ink2 : theme.ink)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(tone == .idle ? Color.clear : theme.wash(tone), in: RoundedRectangle(cornerRadius: 4))
            .overlay {
                if tone == .idle { RoundedRectangle(cornerRadius: 4).stroke(theme.lineStrong, lineWidth: 1) }
            }
    }
}

/// An icon and a few words for a state, with a value after them.
struct StatusLine: View {
    @Environment(\.theme) private var theme
    let tone: Tone
    let icon: String
    let title: String
    var value: String? = nil
    var quiet = false

    init(_ words: UpdateWords) {
        tone = words.tone
        icon = words.icon
        title = words.title
        value = words.progress.map { "\($0)%" }
        quiet = words.quiet
    }

    init(_ look: Look) {
        tone = look.tone
        icon = look.icon
        title = look.label
    }

    init(tone: Tone, icon: String, title: String, value: String? = nil, quiet: Bool = false) {
        self.tone = tone
        self.icon = icon
        self.title = title
        self.value = value
        self.quiet = quiet
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Image(systemName: Icon.symbol(icon))
                .foregroundStyle(quiet ? theme.ink3 : theme.tone(tone))
                .accessibilityHidden(true)
            Text(title)
                .fontWeight(quiet ? .regular : .semibold)
                .foregroundStyle(quiet ? theme.ink3 : theme.ink)
                .fixedSize(horizontal: false, vertical: true)
            if let value {
                Text(value)
                    .fontWeight(.medium)
                    .monospacedDigit()
                    .foregroundStyle(theme.ink2)
            }
        }
        .font(Typeface.body)
        .accessibilityElement(children: .combine)
    }
}

/// A message on a screen: what went wrong or what to watch, with a way on.
struct Notice<Action: View>: View {
    @Environment(\.theme) private var theme
    let tone: Tone
    let icon: String
    let text: String
    var more: String? = nil
    let action: Action

    init(_ tone: Tone, _ icon: String, _ text: String, more: String? = nil, @ViewBuilder action: () -> Action) {
        self.tone = tone
        self.icon = icon
        self.text = text
        self.more = more
        self.action = action()
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: Icon.symbol(icon))
                .foregroundStyle(theme.tone(tone))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 8) {
                Text(text)
                    .font(Typeface.body)
                    .fixedSize(horizontal: false, vertical: true)
                if let more {
                    Text(more)
                        .font(Typeface.small)
                        .foregroundStyle(theme.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                action
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 13)
        .padding(.horizontal, 16)
        .background(tone == .bad || tone == .warn ? theme.wash(tone) : theme.well,
                    in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay {
            if !(tone == .bad || tone == .warn) {
                RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(theme.line, lineWidth: 1)
            }
        }
        .accessibilityElement(children: .contain)
    }
}

extension Notice where Action == EmptyView {
    init(_ tone: Tone, _ icon: String, _ text: String, more: String? = nil) {
        self.init(tone, icon, text, more: more, action: { EmptyView() })
    }
}

/// A label and its value side by side, as the website's facts.
struct Fact<Value: View>: View {
    @Environment(\.theme) private var theme
    let label: String
    let value: Value

    init(_ label: String, @ViewBuilder value: () -> Value) {
        self.label = label
        self.value = value()
    }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                labelText.frame(width: 96, alignment: .leading)
                VStack(alignment: .leading, spacing: 6) { value }
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            VStack(alignment: .leading, spacing: 4) {
                labelText
                VStack(alignment: .leading, spacing: 6) { value }
            }
        }
        .font(Typeface.body)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) {
            Rectangle().fill(theme.line).frame(height: 1)
        }
        .accessibilityElement(children: .combine)
    }

    private var labelText: some View {
        Text(label)
            .font(Typeface.small)
            .foregroundStyle(theme.ink3)
    }
}

/// A note under a fact.
struct FactNote: View {
    @Environment(\.theme) private var theme
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(Typeface.small)
            .foregroundStyle(theme.ink3)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// Monospace, for versions, board names and digests.
struct Mono: View {
    let text: String
    var strong = false
    var font: Font = Typeface.monoBody

    init(_ text: String, strong: Bool = false, font: Font = Typeface.monoBody) {
        self.text = text
        self.strong = strong
        self.font = font
    }

    var body: some View {
        Text(verbatim: text)
            .font(font)
            .fontWeight(strong ? .semibold : .regular)
            .textSelection(.enabled)
    }
}

/// A thin bar for a download in progress.
struct Meter: View {
    @Environment(\.theme) private var theme
    let percent: Int
    var label: String = "Progress"

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(theme.line)
                Capsule().fill(theme.work)
                    .frame(width: geometry.size.width * CGFloat(min(max(percent, 0), 100)) / 100)
            }
        }
        .frame(height: 6)
        .accessibilityElement()
        .accessibilityLabel(label)
        .accessibilityValue("\(percent) percent")
    }
}

/// Wi-Fi bars out of four.
struct SignalBars: View {
    @Environment(\.theme) private var theme
    let bars: Int
    var old = false

    var body: some View {
        HStack(alignment: .bottom, spacing: 2) {
            ForEach(0..<4, id: \.self) { index in
                RoundedRectangle(cornerRadius: 1)
                    .fill(index < bars ? (old ? theme.ink3 : theme.ink) : theme.lineStrong)
                    .frame(width: 4, height: CGFloat(5 + Double(index) * 3.6))
            }
        }
        .accessibilityHidden(true)
    }
}

/// A board's signal in words and bars. An offline board has only the reading it last gave.
struct SignalWords: View {
    @Environment(\.theme) private var theme
    let device: Device

    var body: some View {
        if let quality = Words.signalQuality(device.rssi), let rssi = device.rssi {
            HStack(spacing: 8) {
                SignalBars(bars: quality.bars, old: !device.online)
                if device.online {
                    Text("\(quality.label) · \(Words.signed(rssi)) dBm")
                } else {
                    Text("\(Words.signed(rssi)) dBm when last seen").foregroundStyle(theme.ink3)
                }
            }
        } else {
            Text("Not reported").foregroundStyle(theme.ink3)
        }
    }
}

/// Whether a board is online, as a badge.
struct Presence: View {
    let device: Device

    var body: some View {
        if Words.isRestarting(device) {
            Badge(.idle, "restart", "Restarting")
        } else if device.online {
            Badge(.good, "online", "Online")
        } else if device.lastSeen == nil {
            Badge(.idle, "minus-circle", "Never connected")
        } else {
            Badge(.idle, "offline", "Offline")
        }
    }
}

/// A button that copies a value.
struct CopyButton: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let value: String
    let label: String

    var body: some View {
        Button {
            #if canImport(UIKit)
            UIPasteboard.general.string = value
            #endif
            app.say("Copied \(label).")
        } label: {
            Image(systemName: "doc.on.doc")
                .font(.footnote)
                .foregroundStyle(theme.ink2)
                .frame(minWidth: 32, minHeight: 32)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Copy \(label)")
    }
}

/// A value in monospace with a button that copies it.
struct CopyRow: View {
    let value: String
    let label: String
    var shown: String? = nil

    var body: some View {
        HStack(alignment: .center, spacing: 4) {
            Mono(shown ?? value, font: Typeface.mono)
                .lineLimit(shown == nil ? nil : 1)
            CopyButton(value: value, label: label)
        }
    }
}

/// The console's buttons: ink-bordered, rust for the one thing to do, red for what destroys.
struct ConsoleButtonStyle: ButtonStyle {
    enum Kind { case normal, primary, danger, dangerQuiet, quiet }
    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var enabled
    var kind: Kind = .normal
    var wide = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Typeface.body.weight(.semibold))
            .lineLimit(2)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 15)
            .frame(minHeight: 44)
            .frame(maxWidth: wide ? .infinity : nil)
            .foregroundStyle(foreground)
            .background(background(configuration.isPressed), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
            .overlay {
                if kind != .quiet {
                    RoundedRectangle(cornerRadius: 5, style: .continuous).stroke(border, lineWidth: 1)
                }
            }
            .opacity(enabled ? 1 : 0.5)
            .contentShape(Rectangle())
    }

    private var foreground: Color {
        switch kind {
        case .primary: return theme.onAccent
        case .danger: return theme.onBadFill
        case .dangerQuiet: return theme.bad
        default: return theme.ink
        }
    }

    private var border: Color {
        switch kind {
        case .primary: return theme.accent
        case .danger: return theme.badFill
        default: return theme.lineField
        }
    }

    private func background(_ pressed: Bool) -> Color {
        switch kind {
        case .primary: return pressed ? theme.accentStrong : theme.accent
        case .danger: return theme.badFill.opacity(pressed ? 0.85 : 1)
        default: return pressed ? theme.well : .clear
        }
    }
}

extension View {
    func consoleButton(_ kind: ConsoleButtonStyle.Kind = .normal, wide: Bool = false) -> some View {
        buttonStyle(ConsoleButtonStyle(kind: kind, wide: wide))
    }
}

/// What a card shows while its data is on the way.
struct Loading: View {
    @Environment(\.theme) private var theme
    let what: String

    var body: some View {
        HStack(spacing: 10) {
            ProgressView()
            Text("Loading \(what)…").foregroundStyle(theme.ink3)
        }
        .font(Typeface.body)
    }
}

/// Nothing here yet, and the way on.
struct EmptyState: View {
    @Environment(\.theme) private var theme
    let icon: String
    let title: String
    var text: String? = nil
    var command: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: Icon.symbol(icon))
                .font(.title2)
                .foregroundStyle(theme.ink3)
                .accessibilityHidden(true)
            Text(title).font(Typeface.heading)
            if let text {
                Text(text).font(Typeface.body).foregroundStyle(theme.ink2).fixedSize(horizontal: false, vertical: true)
            }
            if let command {
                Mono(command, font: Typeface.mono)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(theme.well, in: RoundedRectangle(cornerRadius: 4))
            }
        }
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    static let noBoards = EmptyState(icon: "chip", title: "No boards are registered yet.", text: "Provision one with",
                                     command: "python3 tools/provision_device.py")
}

/// Could not load (or refresh) what a screen shows: the server's words, and a way to try again.
struct LoadProblem: View {
    let what: String
    let error: Error
    var loadedAt: Date? = nil
    let retry: () -> Void

    var body: some View {
        Notice(.bad, "alert",
               "\(loadedAt != nil ? "Could not refresh" : "Could not load") \(what). \(Words.sentence(Words.plainMessage(error)))",
               more: [loadedAt.map { "Showing what was loaded \(Words.timeAgo(ConsoleTime.text($0), now: Date()))." },
                      Words.problemRef(error)].compactMap { $0 }.joined(separator: " ").nilIfEmpty) {
            Button("Try again", action: retry).consoleButton()
        }
    }
}

/// How fresh a screen is: live while it is polled, otherwise when it was loaded.
struct Freshness: View {
    @Environment(\.theme) private var theme
    let loadedAt: Date?
    let interval: TimeInterval
    let loading: Bool

    var body: some View {
        TimelineView(.periodic(from: .now, by: 5)) { context in
            HStack(spacing: 6) {
                if interval > 0 && interval <= 15 {
                    Circle().fill(theme.good).frame(width: 7, height: 7)
                    Text("Live · every \(Int(interval)) s")
                } else if let loadedAt {
                    Text("Updated \(Words.timeAgo(ConsoleTime.text(loadedAt), now: context.date))")
                }
                if loading { ProgressView().controlSize(.mini) }
            }
            .font(Typeface.tiny)
            .foregroundStyle(theme.ink3)
        }
    }
}

/// The steps of one board's update, as the website's step indicator.
struct StepList: View {
    @Environment(\.theme) private var theme
    let words: ExecutionWords
    var compact = false
    var viewer = false

    private static let icons = ["send", "press", "download", "shield", "restart", "pulse", "check-circle"]

    var body: some View {
        if compact {
            HStack(spacing: 3) {
                ForEach(Array(words.steps.enumerated()), id: \.offset) { index, step in
                    Capsule().fill(fill(step)).frame(height: 5)
                        .accessibilityHidden(true)
                }
            }
            .accessibilityElement()
            .accessibilityLabel("Steps of the update")
            .accessibilityValue(words.steps.map { "\($0.label): \(word($0))" }.joined(separator: ", "))
        } else {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(words.steps.enumerated()), id: \.offset) { index, step in
                    HStack(alignment: .center, spacing: 12) {
                        mark(step, index: index)
                        VStack(alignment: .leading, spacing: 1) {
                            HStack(spacing: 6) {
                                Text(step.label)
                                    .font(Typeface.body.weight(step.state == .current || step.state == .failed ? .semibold : .regular))
                                    .foregroundStyle(step.state == .upcoming || step.state == .skipped || step.state == .unknown
                                                     ? theme.ink3 : theme.ink)
                                if step.state == .current, index == 2, let progress = words.progress {
                                    Text("\(progress)%").font(Typeface.body.weight(.semibold)).monospacedDigit()
                                }
                            }
                            Text(word(step))
                                .font(Typeface.tiny)
                                .foregroundStyle(theme.ink3)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 4)
                    .accessibilityElement(children: .combine)
                    if index < words.steps.count - 1 {
                        Rectangle()
                            .fill(step.state == .done ? theme.ink2 : theme.line)
                            .frame(width: 2, height: 10)
                            .padding(.leading, 13)
                            .accessibilityHidden(true)
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Steps of the update")
        }
    }

    private func word(_ step: Step) -> String {
        if step.state == .current {
            if words.tone == .act { return viewer ? "waiting for someone" : "your turn" }
            if words.tone == .wait { return "waiting" }
        }
        return step.stateWord
    }

    private func fill(_ step: Step) -> Color {
        switch step.state {
        case .done: return theme.ink2
        case .current: return theme.tone(words.tone)
        case .failed: return theme.tone(words.tone == .warn ? .warn : .bad)
        case .stopped: return theme.ink3
        default: return theme.line
        }
    }

    @ViewBuilder
    private func mark(_ step: Step, index: Int) -> some View {
        let symbol: String = {
            switch step.state {
            case .done: return "checkmark"
            case .stopped, .unknown: return "minus"
            case .failed:
                if words.icon == "undo" || words.icon == "ban" { return Icon.symbol(words.icon) }
                return words.tone == .warn ? "minus" : "xmark"
            default: return Icon.symbol(Self.icons[min(index, Self.icons.count - 1)])
            }
        }()
        let color: Color = {
            switch step.state {
            case .done: return theme.ink
            case .current: return theme.tone(words.tone)
            case .failed: return theme.tone(words.tone)
            default: return theme.lineMark
            }
        }()
        ZStack {
            Circle()
                .fill(step.state == .done ? theme.well : (step.state == .current ? theme.wash(words.tone) : Color.clear))
            Circle()
                .stroke(color, lineWidth: step.state == .current ? 2 : 1.25)
            Image(systemName: symbol)
                .font(.caption2.weight(.bold))
                .foregroundStyle(color)
        }
        .frame(width: 28, height: 28)
    }
}

/// The two buttons on the board, while it waits for a person.
struct ButtonKeys: View {
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: 14) {
            key(lit: true, name: "Button 1", does: "installs")
            key(lit: false, name: "Button 2", does: "declines")
        }
        .accessibilityHidden(true)
    }

    private func key(lit: Bool, name: String, does: String) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(lit ? theme.accent : theme.well)
                .overlay(Circle().stroke(theme.lineStrong, lineWidth: 1))
                .frame(width: 22, height: 22)
            VStack(alignment: .leading, spacing: 0) {
                Text(name).font(Typeface.small.weight(.semibold))
                Text(does).font(Typeface.tiny).foregroundStyle(theme.ink3)
            }
        }
    }
}

/// Board counts by state, as icons and words.
struct CountList: View {
    @Environment(\.theme) private var theme
    let lines: [CountLine]
    var percent: Int? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(lines) { line in
                StatusLine(tone: line.tone, icon: line.icon, title: "\(line.count) \(line.label)",
                           value: percent != nil && line.name == "inProgress" ? "· \(percent!)%" : nil)
            }
        }
    }
}

/// The share of boards in each state, as a bar of segments.
struct Segments: View {
    @Environment(\.theme) private var theme
    let lines: [CountLine]

    var body: some View {
        let total = max(lines.reduce(0) { $0 + $1.count }, 1)
        GeometryReader { geometry in
            HStack(spacing: 2) {
                ForEach(lines) { line in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(theme.bar(line.tone))
                        .frame(width: max(4, (geometry.size.width - CGFloat(lines.count - 1) * 2) * CGFloat(line.count) / CGFloat(total)))
                }
            }
        }
        .frame(height: 8)
        .accessibilityElement()
        .accessibilityLabel("Boards: \(lines.map { "\($0.count) \($0.label)" }.joined(separator: ", ")).")
    }
}

/// A navigation row: the whole row is the link, with a chevron.
struct RowLink<Label: View>: View {
    @Environment(\.theme) private var theme
    let route: Route
    let label: Label

    init(_ route: Route, @ViewBuilder label: () -> Label) {
        self.route = route
        self.label = label()
    }

    var body: some View {
        NavigationLink(value: route) {
            HStack(alignment: .center, spacing: 10) {
                label.frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(theme.ink3)
                    .accessibilityHidden(true)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// A divider between rows.
struct RowRule: View {
    @Environment(\.theme) private var theme

    var body: some View {
        Rectangle().fill(theme.line).frame(height: 1)
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

/// A board as people know it: its device ID first, when it has reported one, and its thing name
/// second, smaller and quieter. The thing name alone until then. Every call uses the thing name.
struct BoardTitle: View {
    @Environment(\.theme) private var theme
    let thing: String
    let name: String?
    var large = false

    init(_ thing: String, name: String?, large: Bool = false) {
        self.thing = thing
        self.name = name
        self.large = large
    }

    init(_ device: Device, large: Bool = false) {
        self.init(device.thing, name: device.name, large: large)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            if let name {
                Text(verbatim: name)
                    .font(large ? Typeface.title : Typeface.body.weight(.semibold))
                    .foregroundStyle(theme.ink)
                Text(verbatim: thing)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(theme.ink3)
                    .lineLimit(1)
                    .truncationMode(.middle)
            } else {
                Text(verbatim: thing)
                    .font(large ? .system(.title3, design: .monospaced).weight(.semibold) : Typeface.monoStrong)
                    .foregroundStyle(theme.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .minimumScaleFactor(0.8)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(name.map { "Board \($0), \(thing)" } ?? "Board \(thing)")
    }
}

extension AppModel {
    /// The board of that thing name, as the board list has it, if it has been read.
    func device(_ thing: String) -> Device? {
        deviceList?.first { $0.thing == thing }
    }

    /// A board's device ID, if it has reported one.
    func name(of thing: String) -> String? {
        device(thing)?.name ?? deviceDetails[thing]?.value?.device.name
    }
}
