import CraniumKit
import SwiftUI

/// The shell on screen: the web view of the bundle, and around it what only the app can do. A line for an
/// example build, the lock screen after 5 minutes away while a sign-in is behind Face ID, the offer to turn
/// Face ID on after a sign-in, and the shell's settings (from the page's App settings, `app.settings`).
struct ShellRoot: View {
    @StateObject private var model = ShellModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(spacing: 0) {
            if model.loaded?.source == .example {
                ExampleConfigBanner()
            }
            if model.needsNewerApp {
                Text("The console's newest pages need a newer version of this app. Update it with SideStore.")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.page.ink)
                    .padding(10)
                    .frame(maxWidth: .infinity)
                    .background(Theme.page.warnWash)
            }
            if let release = model.appUpdate {
                AppUpdateBanner(release: release, running: model.shellVersion) { model.showAppUpdate = true }
            }
            ZStack {
                Theme.page.paper.ignoresSafeArea()
                if model.bundle != nil {
                    ShellWebView(model: model)
                        .ignoresSafeArea(.container, edges: .bottom)
                } else {
                    ProgressView()
                }
                if let cover = model.cover {
                    ShellCover(cover: cover, model: model)
                }
            }
        }
        .task { await model.start() }
        .onChange(of: scenePhase) { phase in
            Task { await model.scene(phase) }
        }
        .sheet(isPresented: $model.showSettings) {
            ShellSettingsView(model: model)
        }
        .sheet(isPresented: $model.showAppUpdate) {
            AppUpdateSheet(model: model)
        }
        .alert(item: $model.offer) { offer in
            Alert(title: Text("Open Cranium with \(offer.biometry.name)?"),
                  message: Text("Your sign-in stays on this iPhone for up to 30 days, behind \(offer.biometry.name). "
                      + "A change still asks for your password and code."),
                  primaryButton: .default(Text("Use \(offer.biometry.name)")) { Task { await model.answerOffer(offer, yes: true) } },
                  secondaryButton: .cancel(Text("Not now")) { Task { await model.answerOffer(offer, yes: false) } })
        }
    }
}

/// Over the page: blank in the app switcher, and the lock screen after 5 minutes away.
struct ShellCover: View {
    let cover: ShellModel.Cover
    @ObservedObject var model: ShellModel

    var body: some View {
        ZStack {
            Theme.page.paper.ignoresSafeArea()
            if cover == .lock {
                VStack(spacing: 16) {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 40))
                        .foregroundStyle(Theme.page.accent)
                    Text("Cranium is locked")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(Theme.page.ink)
                    if let message = model.lockMessage {
                        Text(message)
                            .font(.subheadline)
                            .foregroundStyle(Theme.page.ink2)
                            .multilineTextAlignment(.center)
                    }
                    Button("Unlock") { Task { await model.unlock() } }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("shell-unlock")
                    Button("Sign out") { Task { await model.signOutLocked() } }
                        .font(.subheadline)
                }
                .padding(32)
            }
        }
        .accessibilityIdentifier(cover == .lock ? "shell-lock" : "shell-privacy")
    }
}

/// The shell's own settings: what it runs, the check for newer pages, Reload, and the classic app.
struct ShellSettingsView: View {
    @ObservedObject var model: ShellModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationView {
            Form {
                Section {
                    row("App", "\(model.shellVersion) (\(model.shellBuild))")
                    if let bundle = model.bundle {
                        row("Pages", bundle.manifest.consoleVersion.map { "console \($0)" } ?? "console unknown")
                        row("Bundle", bundle.id)
                        row("From", bundle.source == .builtIn ? "built into the app" : "the console")
                    }
                } header: {
                    Text("This app")
                } footer: {
                    Text("The screens are the console's own pages, kept on this iPhone and updated from the console without a reinstall. Only the app around them comes from SideStore.")
                }
                Section {
                    Button(model.checking ? "Looking…" : "Look for newer pages now") {
                        Task { await model.checkForUpdate(force: true) }
                    }
                    .disabled(model.checking)
                    if let note = model.updateNote {
                        Text(note).font(.footnote).foregroundStyle(Theme.page.ink2)
                    }
                    Button("Reload") {
                        dismiss()
                        Task { await model.reload() }
                    }
                }
                Section {
                    Toggle("Classic app", isOn: Binding(get: { false }, set: { on in
                        if on {
                            dismiss()
                            ShellChoice.shared.useClassic()
                        }
                    }))
                    .accessibilityIdentifier("classic-toggle")
                } footer: {
                    Text("The app's own screens of 0.7, for this version only. Its line at the top, or the Home Screen's quick action, comes back here.")
                }
            }
            .navigationTitle("App settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }

    private func row(_ title: String, _ value: String) -> some View {
        HStack {
            Text(title)
            Spacer()
            Text(value).foregroundStyle(Theme.page.ink2).font(.footnote.monospaced())
        }
    }
}
