import CraniumKit
import SwiftUI

/// The window: the web view of the bundle, and around it what only the app can do. A line for an example
/// build, the lock screen after the Mac was away while a sign-in is behind Touch ID, the offer to turn Touch
/// ID on after a sign-in, and the settings sheet (the page's App settings, `app.settings`).
struct MacShellRoot: View {
    @ObservedObject var model: MacShellModel
    private let paper = Color(red: 250 / 255, green: 247 / 255, blue: 242 / 255)

    var body: some View {
        VStack(spacing: 0) {
            if model.loaded?.source == .example {
                Text("This build has the example configuration, not the team's, so it cannot sign in.")
                    .font(.footnote.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(8)
                    .background(Color.yellow.opacity(0.25))
            }
            if model.needsNewerApp {
                Text("The console's newest pages need a newer version of this app.")
                    .font(.footnote.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(8)
                    .background(Color.yellow.opacity(0.25))
            }
            ZStack {
                paper
                switch model.phase {
                case .ready:
                    MacWebView(model: model)
                case .loading:
                    ProgressView()
                case .failed(let why):
                    Text(why).foregroundColor(.black.opacity(0.7)).padding(32)
                }
                if let cover = model.cover {
                    MacShellCover(cover: cover, model: model)
                }
            }
        }
        .task { await model.start() }
        .sheet(isPresented: $model.showSettings) {
            MacShellSettings(model: model)
        }
        .alert(item: $model.offer) { offer in
            Alert(title: Text("Open Cranium with \(offer.biometry.name)?"),
                  message: Text("Your sign-in stays on this Mac for up to 30 days, behind \(offer.biometry.name). "
                      + "A change still asks for your password and code."),
                  primaryButton: .default(Text("Use \(offer.biometry.name)")) { Task { await model.answerOffer(offer, yes: true) } },
                  secondaryButton: .cancel(Text("Not now")) { Task { await model.answerOffer(offer, yes: false) } })
        }
    }
}

/// Over the page: blank while the app is behind, and the lock screen after the Mac was away.
struct MacShellCover: View {
    let cover: MacShellModel.Cover
    @ObservedObject var model: MacShellModel

    var body: some View {
        ZStack {
            Color(red: 250 / 255, green: 247 / 255, blue: 242 / 255)
            if cover == .lock {
                VStack(spacing: 14) {
                    Image(systemName: "lock.fill").font(.system(size: 36))
                    Text("Cranium is locked").font(.title2.weight(.bold))
                    if let message = model.lockMessage {
                        Text(message).font(.subheadline).foregroundColor(.secondary).multilineTextAlignment(.center)
                    }
                    Button("Unlock") { Task { await model.unlock() } }
                        .keyboardShortcut(.defaultAction)
                    Button("Sign out") { Task { await model.signOutLocked() } }
                }
                .foregroundColor(.black.opacity(0.8))
                .padding(32)
            }
        }
    }
}

/// The app's own settings: what it runs, the check for newer pages, Reload, and when Touch ID is asked again.
struct MacShellSettings: View {
    @ObservedObject var model: MacShellModel
    @Environment(\.dismiss) private var dismiss
    @State private var prefs = MacLockPreferences.load()

    var body: some View {
        Form {
            Section("This app") {
                LabeledContent("App", value: "\(model.shellVersion) (\(model.shellBuild))")
                if let bundle = model.bundle {
                    LabeledContent("Pages", value: bundle.manifest.consoleVersion.map { "console \($0)" } ?? "console unknown")
                    LabeledContent("From", value: bundle.source == .builtIn ? "built into the app" : "the console")
                }
            }
            Section {
                Button(model.checking ? "Looking..." : "Look for newer pages now") {
                    Task { await model.checkForUpdate(force: true) }
                }
                .disabled(model.checking)
                if let note = model.updateNote { Text(note).font(.footnote).foregroundColor(.secondary) }
                Button("Reload") {
                    dismiss()
                    Task { await model.reload() }
                }
            }
            Section("Touch ID") {
                Picker(MacLockWords.relock, selection: $prefs.relock) {
                    ForEach(RelockChoice.allCases) { Text($0.title).tag($0) }
                }
                Toggle(MacLockWords.lockWhenMacSleeps, isOn: $prefs.lockWhenMacSleeps)
                Text("Applies the next time the app starts.").font(.footnote).foregroundColor(.secondary)
            }
        }
        .formStyle(.grouped)
        .frame(width: 440, height: 440)
        .onChange(of: prefs) { $0.save() }
        .overlay(alignment: .bottomTrailing) { Button("Done") { dismiss() }.padding(12) }
    }
}
