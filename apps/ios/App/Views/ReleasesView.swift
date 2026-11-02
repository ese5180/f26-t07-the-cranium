import CraniumKit
import SwiftUI

/// Step 2: pick a release. The newest active one is chosen by default.
struct ReleasesView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            List {
                Section {
                    if model.releases.isEmpty && !model.busy {
                        Text("No active releases. Upload one on the console's Firmware page.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(model.releases) { release in
                        ReleaseRow(release: release, selected: release.version == model.preferred)
                            .contentShape(Rectangle())
                            .onTapGesture { model.preferred = release.version }
                    }
                } header: {
                    Text("Active releases, newest first")
                } footer: {
                    Text("The board will only take a release newer than the one it runs. Once it is connected, only those are offered.")
                }
            }
            .refreshable { await model.refresh() }

            VStack(spacing: 12) {
                if let message = model.message {
                    MessageText(text: message)
                }
                WideButton(title: model.chosenRelease.map { "Continue with \($0.version)" } ?? "Continue",
                           busy: model.busy,
                           enabled: model.canDownload && model.chosenRelease != nil) {
                    Task { await model.continueToBoards() }
                }
            }
            .padding()
        }
    }
}

struct ReleaseRow: View {
    let release: FirmwareRelease
    let selected: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(release.version)
                    .font(.body.monospacedDigit().weight(.semibold))
                if let uploaded = Self.date(release.uploadedAt) {
                    Text("Uploaded \(uploaded.formatted(date: .abbreviated, time: .shortened))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let notes = release.notes, !notes.isEmpty {
                    Text(notes)
                        .font(.callout)
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    static func date(_ text: String?) -> Date? {
        guard let text else { return nil }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return withFraction.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
}
