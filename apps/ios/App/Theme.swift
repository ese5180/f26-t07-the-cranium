import CraniumKit
import SwiftUI

/// The console's colours (cloud/web/src/site/assets/app.css), from the colour sets that
/// scripts/colors.sh makes: warm paper and ink, one rust accent, and the status tones. `page` is
/// the page in light and dark; `panel` is an ink panel, dark in both, which holds what matters
/// most on a screen, as on the website.
struct Theme {
    let isPanel: Bool
    let paper: Color
    let surface: Color
    let well: Color
    let line: Color
    let lineStrong: Color
    let lineField: Color
    let lineMark: Color
    let rule: Color
    let ink: Color
    let ink2: Color
    let ink3: Color
    let accent: Color
    let accentStrong: Color
    let accentWash: Color
    let onAccent: Color
    let good: Color
    let goodWash: Color
    let warn: Color
    let warnWash: Color
    let bad: Color
    let badWash: Color
    let work: Color
    let workWash: Color
    let badFill: Color
    let onBadFill: Color
    let barGood: Color
    let barLive: Color
    let barAct: Color
    let barWait: Color
    let barBad: Color
    let barWarn: Color
    let barIdle: Color
    let kindA: Color
    let kindB: Color
    let kindC: Color
    let kindQuiet: Color
    let series: Color
    let bandOnline: Color

    private init(_ family: String) {
        func c(_ name: String) -> Color { Color(family + name) }
        isPanel = family == "Panel"
        paper = c("Paper")
        surface = c("Surface")
        well = c("Well")
        line = c("Line")
        lineStrong = c("LineStrong")
        lineField = c("LineField")
        lineMark = c("LineMark")
        rule = c("Rule")
        ink = c("Ink")
        ink2 = c("Ink2")
        ink3 = c("Ink3")
        accent = c("Accent")
        accentStrong = c("AccentStrong")
        accentWash = c("AccentWash")
        onAccent = c("OnAccent")
        good = c("Good")
        goodWash = c("GoodWash")
        warn = c("Warn")
        warnWash = c("WarnWash")
        bad = c("Bad")
        badWash = c("BadWash")
        work = c("Work")
        workWash = c("WorkWash")
        badFill = c("BadFill")
        onBadFill = c("OnBadFill")
        barGood = c("BarGood")
        barLive = c("BarLive")
        barAct = c("BarAct")
        barWait = c("BarWait")
        barBad = c("BarBad")
        barWarn = c("BarWarn")
        barIdle = c("BarIdle")
        kindA = c("KindA")
        kindB = c("KindB")
        kindC = c("KindC")
        kindQuiet = c("KindQuiet")
        series = c("Series")
        bandOnline = c("BandOnline")
    }

    static let page = Theme("Page")
    static let panel = Theme("Panel")

    /// The colour of a state's icon. Rust is never "at work": rust is the brand and "your move".
    func tone(_ tone: Tone) -> Color {
        switch tone {
        case .good: return good
        case .warn: return warn
        case .bad: return bad
        case .live: return work
        case .act: return accent
        case .wait, .idle: return ink2
        }
    }

    /// The fill behind a badge or a notice of that tone.
    func wash(_ tone: Tone) -> Color {
        switch tone {
        case .good: return goodWash
        case .warn: return warnWash
        case .bad: return badWash
        case .live: return workWash
        case .act: return accentWash
        case .wait: return well
        case .idle: return .clear
        }
    }

    /// A mark in a chart or an outcome bar.
    func bar(_ tone: Tone) -> Color {
        switch tone {
        case .good: return barGood
        case .live: return barLive
        case .act: return barAct
        case .wait: return barWait
        case .bad: return barBad
        case .warn: return barWarn
        case .idle: return barIdle
        }
    }

    /// The hue of a family of events on the timeline.
    func kind(_ hue: String) -> Color {
        switch hue {
        case "a": return kindA
        case "b": return kindB
        case "c": return kindC
        default: return kindQuiet
        }
    }
}

private struct ThemeKey: EnvironmentKey {
    static let defaultValue = Theme.page
}

extension EnvironmentValues {
    var theme: Theme {
        get { self[ThemeKey.self] }
        set { self[ThemeKey.self] = newValue }
    }
}

/// The console's type: the system face, set like the website's (15 px body, small caps eyebrows,
/// tabular figures), and following Dynamic Type.
enum Typeface {
    static let body = Font.subheadline
    static let small = Font.footnote
    static let tiny = Font.caption
    static let eyebrow = Font.caption2.weight(.semibold)
    static let title = Font.title2.weight(.bold)
    static let heading = Font.headline
    static let figure = Font.system(.largeTitle, design: .default).weight(.semibold)
    static let mono = Font.system(.footnote, design: .monospaced)
    static let monoBody = Font.system(.subheadline, design: .monospaced)
    static let monoStrong = Font.system(.subheadline, design: .monospaced).weight(.semibold)
}

/// The website's icons (views.js ICONS) as SF Symbols.
enum Icon {
    static func symbol(_ name: String) -> String {
        switch name {
        case "check-circle": return "checkmark.circle"
        case "x-circle": return "xmark.circle"
        case "clock": return "clock"
        case "restart": return "arrow.clockwise"
        case "download": return "arrow.down.to.line"
        case "shield": return "checkmark.shield"
        case "pulse": return "waveform.path.ecg"
        case "press": return "hand.point.up.left"
        case "undo": return "arrow.uturn.backward"
        case "ban": return "nosign"
        case "minus-circle": return "minus.circle"
        case "minus": return "minus"
        case "stop": return "stop.circle"
        case "hourglass": return "hourglass"
        case "alert": return "exclamationmark.triangle"
        case "offline": return "wifi.slash"
        case "online": return "wifi"
        case "upload": return "arrow.up.to.line"
        case "send": return "paperplane"
        case "chip": return "cpu"
        case "key": return "key"
        case "list": return "list.bullet"
        case "lock": return "lock"
        case "check": return "checkmark"
        case "x": return "xmark"
        case "package": return "shippingbox"
        case "file": return "doc"
        case "user": return "person"
        case "swap": return "arrow.up.arrow.down"
        case "copy": return "doc.on.doc"
        case "plus": return "plus"
        case "arrow-right": return "chevron.right"
        case "bluetooth": return "dot.radiowaves.left.and.right"
        case "bell": return "bell"
        default: return "circle"
        }
    }
}
