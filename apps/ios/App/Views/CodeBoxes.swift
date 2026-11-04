import CraniumKit
import SwiftUI

/// The code from the authenticator app in six boxes, two groups of three, as on the website's
/// sign-in page (app.css, `.code-boxes`): 52 by 60 points each, 8 apart and 18 between the groups,
/// the digits in the monospaced face, the box that takes the next digit ringed in rust, every box
/// ringed in red when the code was wrong. On a narrow phone the boxes shrink to fit.
///
/// One hidden text field, with the number pad and the one-time-code content type, takes the input,
/// so that iOS can fill the code in from the Passwords app and a long press can paste one; the six
/// boxes only draw what it holds. VoiceOver hears that one field: "Code, 6 digits".
struct CodeBoxes: View {
    @Environment(\.theme) private var theme
    /// The digits so far: at most six.
    let digits: String
    var wrong = false
    /// A request is on its way: read-only, in the well's colour.
    var busy = false
    var focused: FocusState<Bool>.Binding
    /// What the field now holds (typed, pasted, filled in); returns the digits to show from then on.
    let onEdit: @MainActor (String) -> String

    /// The field's own text, set back to `digits` whenever the two differ.
    @State private var text = ""
    @State private var caretOn = true
    @ScaledMetric(relativeTo: .title) private var boxWidth: CGFloat = 52
    @ScaledMetric(relativeTo: .title) private var boxHeight: CGFloat = 60
    @ScaledMetric(relativeTo: .title) private var digitSize: CGFloat = 26

    var body: some View {
        HStack(spacing: 18) {
            group(0..<3)
            group(3..<6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay { field }
        .contentShape(Rectangle())
        .simultaneousGesture(TapGesture().onEnded { if !busy { focused.wrappedValue = true } })
        .onAppear { text = digits }
        .onChange(of: digits) { now in
            if text != now { text = now }
        }
        .onChange(of: text) { now in
            let shown = onEdit(now)
            if shown != now { text = shown }
        }
    }

    private func group(_ indices: Range<Int>) -> some View {
        HStack(spacing: 8) {
            ForEach(indices, id: \.self) { box($0) }
        }
        .accessibilityHidden(true)
    }

    private var characters: [Character] { Array(digits) }

    /// The box the next digit goes into, while the field has the keyboard.
    private var active: Int? {
        guard focused.wrappedValue, !busy else { return nil }
        return min(characters.count, CodeEntry.length - 1)
    }

    private func box(_ index: Int) -> some View {
        let digit = index < characters.count ? String(characters[index]) : ""
        let isActive = active == index
        let border = wrong ? theme.bad : (isActive ? theme.accent : theme.lineField)
        return ZStack {
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(busy ? theme.well : theme.surface)
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .strokeBorder(border, lineWidth: isActive ? 2 : 1)
            if digit.isEmpty {
                if isActive {
                    // The caret, blinking where the next digit goes.
                    Rectangle()
                        .fill(theme.accent)
                        .frame(width: 2, height: digitSize * 1.1)
                        .opacity(caretOn ? 1 : 0)
                        .onAppear { blink() }
                }
            } else {
                Text(digit)
                    .font(.system(size: digitSize, weight: .semibold, design: .monospaced))
                    .foregroundStyle(busy ? theme.ink2 : theme.ink)
            }
        }
        .frame(minWidth: 0, maxWidth: boxWidth)
        .frame(height: boxHeight)
    }

    private func blink() {
        caretOn = true
        withAnimation(.easeInOut(duration: 0.55).repeatForever(autoreverses: true)) { caretOn = false }
    }

    /// The field the keyboard types into. Its text, caret and selection are not drawn; the boxes
    /// under it are.
    private var field: some View {
        TextField("", text: $text)
            .codeInput()
            .foregroundStyle(.clear)
            .tint(.clear)
            .focused(focused)
            .disabled(busy)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityLabel(SignInWords.codeField)
            .accessibilityValue(digits.isEmpty ? "Empty" : digits.map(String.init).joined(separator: " "))
            .accessibilityHint(SignInWords.codeHint)
    }
}

private extension View {
    /// The number pad, and the content type that has iOS offer the code from the Passwords app.
    @ViewBuilder func codeInput() -> some View {
        #if os(iOS)
        self.keyboardType(.numberPad)
            .textContentType(.oneTimeCode)
            .autocorrectionDisabled()
        #else
        self.autocorrectionDisabled()
        #endif
    }
}
