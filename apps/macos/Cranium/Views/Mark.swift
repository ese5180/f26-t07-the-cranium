import SwiftUI

/// Cranium's mark: the arch of the sites' brand-mark and the iPhone app's CraniumMark, in the accent,
/// its grooves in the window's own colour.
struct CraniumMark: View {
    var body: some View {
        GeometryReader { geometry in
            let scale = min(geometry.size.width, geometry.size.height) / 32
            ZStack {
                Dome().fill(Color.accentColor)
                Grooves().stroke(Color(nsColor: .windowBackgroundColor), lineWidth: 1.8 * scale)
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityHidden(true)
    }

    /// In the mark's own 32-by-32 square: M2 18a14 14 0 0 1 28 0v9a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3z
    private struct Dome: Shape {
        func path(in rect: CGRect) -> Path {
            var path = Path()
            path.move(to: CGPoint(x: 2, y: 18))
            path.addRelativeArc(center: CGPoint(x: 16, y: 18), radius: 14, startAngle: .degrees(180), delta: .degrees(180))
            path.addLine(to: CGPoint(x: 30, y: 27))
            path.addRelativeArc(center: CGPoint(x: 27, y: 27), radius: 3, startAngle: .degrees(0), delta: .degrees(90))
            path.addLine(to: CGPoint(x: 5, y: 30))
            path.addRelativeArc(center: CGPoint(x: 5, y: 27), radius: 3, startAngle: .degrees(90), delta: .degrees(90))
            path.closeSubpath()
            return path.applying(CGAffineTransform(scaleX: rect.width / 32, y: rect.height / 32))
        }
    }

    /// M7 30V18a9 9 0 0 1 18 0v12M12 30V18a4 4 0 0 1 8 0v12
    private struct Grooves: Shape {
        func path(in rect: CGRect) -> Path {
            var path = Path()
            for (left, radius) in [(7.0, 9.0), (12.0, 4.0)] {
                path.move(to: CGPoint(x: left, y: 30))
                path.addLine(to: CGPoint(x: left, y: 18))
                path.addRelativeArc(center: CGPoint(x: 16, y: 18), radius: radius, startAngle: .degrees(180), delta: .degrees(180))
                path.addLine(to: CGPoint(x: left + 2 * radius, y: 30))
            }
            return path.applying(CGAffineTransform(scaleX: rect.width / 32, y: rect.height / 32))
        }
    }
}

/// The mark with the name and what this side is, as the sites' brand.
struct Brand: View {
    let subtitle: String

    var body: some View {
        HStack(spacing: 12) {
            CraniumMark().frame(width: 40, height: 40)
            VStack(alignment: .leading, spacing: 1) {
                Text("Cranium").font(.title.weight(.bold))
                Text(subtitle).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
