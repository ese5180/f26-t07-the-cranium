import CraniumKit
import SwiftUI

/// More, Help: every topic, by section.
struct HelpView: View {
    @Environment(\.theme) private var theme

    var body: some View {
        ListScreen {
            if let book = HelpLibrary.book {
                ForEach(book.sections, id: \.title) { section in
                    Section(section.title) {
                        ForEach(section.topics, id: \.self) { id in
                            if let topic = book.topic(id) {
                                NavigationLink(value: Route.help(id)) {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(topic.title)
                                        Text(topic.summary).font(.footnote).foregroundStyle(theme.ink3).lineLimit(2)
                                    }
                                }
                            }
                        }
                    }
                }
            } else {
                Section { StateRow(kind: .failed, text: "Help could not be read from the app.") }
            }
        }
        .screenTitle("Help")
    }
}

/// One Help topic.
struct HelpTopicView: View {
    @Environment(\.theme) private var theme
    @Environment(\.openURL) private var openURL
    let id: String

    var body: some View {
        let topic = HelpLibrary.book?.topic(id)
        ListScreen {
            if let topic {
                Section {
                    Text(topic.summary).font(.subheadline).foregroundStyle(theme.ink2)
                }
                ForEach(Array(groups(topic.blocks).enumerated()), id: \.offset) { _, group in
                    Section {
                        ForEach(Array(group.blocks.enumerated()), id: \.offset) { _, block in
                            render(block)
                        }
                    } header: {
                        if let heading = group.heading { Text(heading) }
                    }
                }
                if topic.id == "about" { AboutRows() }
                Section {
                    Text("From \(topic.sources.joined(separator: ", ")) in the repository.")
                        .font(.caption).foregroundStyle(theme.ink3)
                }
            } else {
                Section { StateRow(kind: .failed, text: "This Help topic is not in the app.") }
            }
        }
        .screenTitle(topic?.title ?? "Help", large: false)
    }

    /// The blocks between headings, each run a section of its own.
    private func groups(_ blocks: [HelpBook.Block]) -> [(heading: String?, blocks: [HelpBook.Block])] {
        var groups: [(heading: String?, blocks: [HelpBook.Block])] = []
        var current: (heading: String?, blocks: [HelpBook.Block]) = (nil, [])
        for block in blocks {
            if case .heading(let title) = block {
                if !current.blocks.isEmpty || current.heading != nil { groups.append(current) }
                current = (title, [])
            } else {
                current.blocks.append(block)
            }
        }
        if !current.blocks.isEmpty || current.heading != nil { groups.append(current) }
        return groups
    }

    @ViewBuilder
    private func render(_ block: HelpBook.Block) -> some View {
        switch block {
        case .heading(let title):
            Text(title).font(.headline)
        case .text(let text):
            Text(text).fixedSize(horizontal: false, vertical: true)
        case .note(let text):
            Label {
                Text(text).font(.subheadline).fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "info.circle").foregroundStyle(theme.ink3)
            }
        case .steps(let items):
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text("\(index + 1)")
                        .font(.footnote.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(theme.accent)
                        .frame(width: 18, alignment: .trailing)
                    Text(item).fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
            }
        case .list(let items):
            ForEach(items, id: \.self) { item in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text("•").foregroundStyle(theme.ink3)
                    Text(item).fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
            }
        case .rows(let rows):
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                VStack(alignment: .leading, spacing: 3) {
                    Text(row.label).font(.subheadline.weight(.semibold))
                    Text(row.text).font(.subheadline).foregroundStyle(theme.ink2).fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, 2)
                .accessibilityElement(children: .combine)
            }
        case .see(let ids):
            ForEach(ids, id: \.self) { other in
                if let topic = HelpLibrary.book?.topic(other) {
                    NavigationLink(value: Route.help(other)) {
                        Label(topic.title, systemImage: "arrow.turn.down.right")
                    }
                }
            }
        case .links(let links):
            ForEach(Array(links.enumerated()), id: \.offset) { _, link in
                Button {
                    openURL(link.url)
                } label: {
                    HStack {
                        Text(link.title)
                        Spacer()
                        Text(link.url.host ?? "").font(.footnote).foregroundStyle(theme.ink3)
                        Image(systemName: "arrow.up.right").font(.footnote).foregroundStyle(theme.ink3)
                    }
                }
                .foregroundStyle(theme.ink)
            }
        }
    }
}

/// This build: its version, the commit it was built from, and the console it talks to.
struct AboutRows: View {
    @Environment(\.theme) private var theme

    var body: some View {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "—"
        let build = info["CFBundleVersion"] as? String ?? "—"
        let commit = info["CraniumCommit"] as? String
        let console = try? CraniumConfig.load(from: .main)
        Section("This app") {
            ValueRow("Version", "\(version) (\(build))")
            HStack {
                Text("Built from")
                Spacer()
                if let commit, !commit.isEmpty {
                    Text(verbatim: commit).font(Typeface.hash).foregroundStyle(theme.ink2)
                } else {
                    Text("Not recorded").foregroundStyle(theme.ink3)
                }
            }
            if let console {
                ValueRow("Console", console.config.consoleURL.host ?? console.config.consoleURL.absoluteString)
            }
        }
    }
}
