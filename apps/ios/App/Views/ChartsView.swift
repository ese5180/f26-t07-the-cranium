import Charts
import CraniumKit
import SwiftUI

/// A line chart of one reading, as the website draws its Diagnostics charts: one series, one axis,
/// a hairline grid, reference lines, the line broken where the board was not reporting, and the
/// latest value written beside the title.
struct ReadingChart: View {
    @Environment(\.theme) private var theme
    let title: String
    let unit: String
    let describe: String
    let points: [Telemetry.Point]
    let gap: TimeInterval
    let from: Date
    let to: Date
    let domain: ClosedRange<Double>
    let ticks: [Double]
    let refs: [(value: Double, label: String)]
    let format: (Double) -> String
    let tick: (Double) -> String
    let emptyText: String
    var words: ((Double) -> String?)? = nil

    var body: some View {
        let runs = Telemetry.runs(points, gap: gap)
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(Typeface.body.weight(.semibold))
                Spacer()
                if let last = points.last {
                    Text(format(last.value) + (words?(last.value).map { " · \($0)" } ?? ""))
                        .font(Typeface.small.weight(.semibold))
                        .monospacedDigit()
                }
            }
            if points.isEmpty {
                Text(emptyText).font(Typeface.small).foregroundStyle(theme.ink3)
                    .frame(maxWidth: .infinity, minHeight: 80, alignment: .leading)
            } else {
                Chart {
                    ForEach(refs, id: \.label) { ref in
                        RuleMark(y: .value(ref.label, ref.value))
                            .foregroundStyle(theme.lineStrong)
                            .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                            .annotation(position: .top, alignment: .leading) {
                                Text(ref.label).font(.caption2).foregroundStyle(theme.ink3)
                            }
                    }
                    ForEach(Array(runs.enumerated()), id: \.offset) { index, run in
                        ForEach(run, id: \.at) { point in
                            LineMark(x: .value("Time", point.at), y: .value(title, point.value),
                                     series: .value("Run", index))
                                .foregroundStyle(theme.series)
                                .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                        }
                        if run.count == 1, let only = run.first {
                            PointMark(x: .value("Time", only.at), y: .value(title, only.value))
                                .foregroundStyle(theme.series)
                                .symbolSize(16)
                        }
                    }
                    if let last = points.last {
                        PointMark(x: .value("Time", last.at), y: .value(title, last.value))
                            .foregroundStyle(theme.series)
                            .symbolSize(30)
                    }
                }
                .chartXScale(domain: from...to)
                .chartYScale(domain: domain)
                .chartYAxis {
                    AxisMarks(position: .leading, values: ticks) { value in
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5)).foregroundStyle(theme.line)
                        AxisValueLabel {
                            if let number = value.as(Double.self) { Text(tick(number)).font(.caption2).foregroundStyle(theme.ink3) }
                        }
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5)).foregroundStyle(theme.line)
                        AxisValueLabel(format: .dateTime.hour().minute()).font(.caption2).foregroundStyle(theme.ink3)
                    }
                }
                .frame(height: 170)
                .accessibilityElement()
                .accessibilityLabel(title)
                .accessibilityValue(summary)
            }
        }
    }

    /// What a screen reader says of the chart: the latest value, the lowest and the highest.
    private var summary: String {
        guard let last = points.last else { return emptyText }
        let values = points.map(\.value)
        return "Latest \(format(last.value)). Lowest \(format(values.min() ?? 0)), highest \(format(values.max() ?? 0)), from \(points.count) readings."
    }
}

private func hoursWords(_ hours: Int) -> String {
    hours % 24 == 0 && hours >= 48 ? "\(hours / 24) d" : "\(hours) h"
}

/// The Wi-Fi signal from the heartbeat.
struct SignalChart: View {
    let samples: Samples

    var body: some View {
        let to = ConsoleTime.date(samples.to) ?? Date()
        ReadingChart(
            title: "Wi-Fi signal, \(hoursWords(samples.hours))",
            unit: "dBm (0 is the strongest)",
            describe: "from the heartbeat every 30 seconds",
            points: Telemetry.points(samples.samples, \.rssi),
            gap: Telemetry.gap(bucketSeconds: samples.bucketSeconds),
            from: to.addingTimeInterval(-Double(samples.hours) * 3600), to: to,
            domain: -100 ... -30, ticks: [-90, -75, -60, -45],
            refs: [(-67, "Good"), (-75, "Fair")],
            format: { "\(Words.signed(Int($0))) dBm" },
            tick: { Words.signed(Int($0)) },
            emptyText: "No readings in the last \(hoursWords(samples.hours)).",
            words: { Words.signalQuality(Int($0))?.label })
    }
}

/// The free memory from the diagnostics report.
struct HeapChart: View {
    let samples: Samples
    let device: Device

    var body: some View {
        let to = ConsoleTime.date(samples.to) ?? Date()
        let points = Telemetry.points(samples.samples, \.heapFree)
        let size = Double(device.diag?.heap?.size ?? max(1024, Int(points.map(\.value).max() ?? 1024)))
        let step: Double = size > 64 * 1024 ? 16 * 1024 : size > 16 * 1024 ? 8 * 1024 : 2 * 1024
        let ticks = stride(from: 0, through: size, by: step).map { $0 }
        ReadingChart(
            title: "Free memory, \(hoursWords(samples.hours))",
            unit: "KiB of the system heap",
            describe: "from the diagnostics report every 5 minutes, of \(Words.fileSize(Int(size))) in all",
            points: points,
            gap: max(Telemetry.gap(bucketSeconds: samples.bucketSeconds), 11 * 60),
            from: to.addingTimeInterval(-Double(samples.hours) * 3600), to: to,
            domain: 0 ... size, ticks: ticks,
            refs: [(size * Telemetry.lowHeapShare, "Low")],
            format: { String(format: "%.1f KiB", $0 / 1024) },
            tick: { String(Int(($0 / 1024).rounded())) },
            emptyText: device.diag != nil ? "No readings in the last \(hoursWords(samples.hours))." : Telemetry.diagMissing(device))
    }
}

/// The shape of a kind of event, in its family's hue: for the timeline, its legend and the list.
struct KindGlyph: View {
    @Environment(\.theme) private var theme
    let kind: String
    var size: CGFloat = 12

    var body: some View {
        let look = Telemetry.kind(kind)
        let color = theme.kind(look.hue)
        Group {
            switch look.shape {
            case "square": RoundedRectangle(cornerRadius: 1.5).fill(color).frame(width: size * 0.8, height: size * 0.8)
            case "diamond": RoundedRectangle(cornerRadius: 1).fill(color).frame(width: size * 0.7, height: size * 0.7).rotationEffect(.degrees(45))
            case "up": Triangle().fill(color).frame(width: size, height: size * 0.85)
            case "down": Triangle().fill(color).frame(width: size, height: size * 0.85).rotationEffect(.degrees(180))
            case "ring": Circle().strokeBorder(color, lineWidth: 2).frame(width: size * 0.8, height: size * 0.8)
            case "bar": Capsule().fill(color).frame(width: size * 0.28, height: size * 1.1)
            default: Circle().fill(color).frame(width: size * 0.85, height: size * 0.85)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

struct Triangle: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.midX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}

/// The Events timeline: a lane per board and one for the console, a band where a board was
/// online, and a marker for each event, by kind. Tapping picks the nearest event.
struct TimelineChart: View {
    @Environment(\.theme) private var theme
    let lanes: [Telemetry.Lane]
    let from: Date
    let to: Date
    let live: Bool
    let hidden: Set<String>
    @Binding var selected: String?

    var body: some View {
        let shown = lanes.map { lane in (lane, lane.markers.filter { !hidden.contains($0.kind) }) }
        Chart {
            ForEach(lanes) { lane in
                if lane.id != "console" {
                    ForEach(Array(Telemetry.onlineBands(lane.markers, from: from, to: to, device: lane.device, live: live).enumerated()),
                            id: \.offset) { _, band in
                        RectangleMark(xStart: .value("From", band.from), xEnd: .value("To", band.to),
                                      y: .value("Lane", lane.id), height: 22)
                            .foregroundStyle(theme.bandOnline.opacity(band.inferred ? 0.6 : 1))
                    }
                }
            }
            ForEach(shown, id: \.0.id) { lane, markers in
                ForEach(markers) { marker in
                    PointMark(x: .value("Time", marker.at), y: .value("Lane", lane.id))
                        .symbol {
                            KindGlyph(kind: marker.kind, size: marker.id == selected ? 16 : 12)
                                .overlay {
                                    if marker.id == selected {
                                        Circle().stroke(theme.ink, lineWidth: 1.5).frame(width: 22, height: 22)
                                    }
                                }
                        }
                }
            }
        }
        .chartXScale(domain: from...to)
        .chartYScale(domain: lanes.map(\.id))
        .chartYAxis {
            AxisMarks(position: .leading, values: lanes.map(\.id)) { value in
                AxisValueLabel {
                    if let id = value.as(String.self) {
                        Text(label(id)).font(.caption2.weight(.semibold)).foregroundStyle(theme.ink2)
                    }
                }
            }
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5)).foregroundStyle(theme.line)
                AxisValueLabel(format: to.timeIntervalSince(from) > 2 * 86_400 ? .dateTime.day().month(.abbreviated)
                               : .dateTime.hour().minute())
                    .font(.caption2).foregroundStyle(theme.ink3)
            }
        }
        .chartOverlay { proxy in
            GeometryReader { geometry in
                Rectangle().fill(.clear).contentShape(Rectangle())
                    .onTapGesture { location in
                        pick(at: location, proxy: proxy, geometry: geometry)
                    }
            }
        }
        .frame(height: CGFloat(max(lanes.count, 1)) * 46 + 30)
        .accessibilityElement()
        .accessibilityLabel("Timeline")
        .accessibilityValue("\(shown.reduce(0) { $0 + $1.1.count }) events on \(lanes.count) lanes. The list below has every one.")
    }

    private func label(_ id: String) -> String {
        guard let lane = lanes.first(where: { $0.id == id }) else { return id }
        if lane.id == "console" { return "Console" }
        return lane.device?.name ?? Words.shortThing(lane.label)
    }

    private func pick(at location: CGPoint, proxy: ChartProxy, geometry: GeometryProxy) {
        let frame = geometry[proxy.plotAreaFrame]
        let x = location.x - frame.origin.x
        let y = location.y - frame.origin.y
        guard let at: Date = proxy.value(atX: x) else { return }
        let laneId: String? = proxy.value(atY: y)
        let candidates = lanes.filter { laneId == nil || $0.id == laneId }.flatMap(\.markers).filter { !hidden.contains($0.kind) }
        let nearest = candidates.min { abs($0.at.timeIntervalSince(at)) < abs($1.at.timeIntervalSince(at)) }
        // Only a marker near the tap: a fiftieth of the range either way.
        if let nearest, abs(nearest.at.timeIntervalSince(at)) < to.timeIntervalSince(from) / 50 {
            selected = nearest.id
        } else {
            selected = nil
        }
    }
}
