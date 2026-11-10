import CraniumKit
import SwiftUI

/// Above the page while the console has a newer iPhone build than this one (`ShellModel.appUpdate`).
struct AppUpdateBanner: View {
    let release: AppUpdate.Release
    let running: String
    let open: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.down.app.fill").foregroundStyle(Theme.page.accent)
            Text(AppUpdate.Words.banner(release, running: running))
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.page.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Update", action: open)
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .accessibilityIdentifier("app-update")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Theme.page.accentWash)
    }
}

/// The two ways to the new version: SideStore first, in one tap on this iPhone, then the Mac.
struct AppUpdateSheet: View {
    @ObservedObject var model: ShellModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationView {
            Form {
                if let release = model.appUpdate {
                    Section {
                        Text("Cranium \(release.version) (build \(release.build)). This iPhone has \(model.shellVersion) (\(model.shellBuild)).")
                        if !release.notes.isEmpty {
                            Text(release.notes).font(.footnote).foregroundStyle(Theme.page.ink2)
                        }
                    } header: {
                        Text("New version")
                    }
                }
                Section {
                    Button {
                        Task { await model.installWithSideStore() }
                    } label: {
                        Label(model.appUpdateBusy ? "Asking the console…" : AppUpdate.Words.sideStoreTitle,
                              systemImage: "arrow.down.circle.fill")
                    }
                    .disabled(model.appUpdateBusy || model.appUpdate == nil)
                    .accessibilityIdentifier("app-update-sidestore")
                    if let message = model.appUpdateMessage {
                        Text(message).font(.footnote).foregroundStyle(Theme.page.ink2)
                    }
                    if model.sideStoreMissing {
                        Text(AppUpdate.Words.noSideStore).font(.footnote).foregroundStyle(Theme.page.ink)
                        Button("Open the console's Apps page") { model.openAppsPage() }
                    }
                } header: {
                    Text("1. On this iPhone")
                } footer: {
                    Text(AppUpdate.Words.sideStoreDetail)
                }
                Section {
                    Text(AppUpdate.Words.macDetail).font(.footnote)
                    ForEach(Array(AppUpdate.Words.macSteps.enumerated()), id: \.offset) { index, step in
                        Text("\(index + 1). \(step)").font(.footnote).foregroundStyle(Theme.page.ink2)
                    }
                    Button("Open the console's Apps page") { model.openAppsPage() }
                } header: {
                    Text("2. \(AppUpdate.Words.macTitle)")
                }
            }
            .navigationTitle("Update Cranium")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }
}
