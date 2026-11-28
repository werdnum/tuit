import SwiftUI
import WidgetKit

nonisolated struct TuitWatchEntry: TimelineEntry, Sendable {
    let date: Date
    let snapshot: WidgetNowSnapshot
}

nonisolated struct TuitWatchProvider: TimelineProvider {
    func placeholder(in context: Context) -> TuitWatchEntry {
        TuitWatchEntry(date: .now, snapshot: .placeholder)
    }

    func getSnapshot(in context: Context, completion: @escaping @Sendable (TuitWatchEntry) -> Void) {
        if context.isPreview {
            completion(TuitWatchEntry(date: .now, snapshot: .placeholder))
            return
        }
        let snapshot = WidgetSnapshotStore.shared.load(area: nil) ?? .signedOut()
        completion(TuitWatchEntry(date: .now, snapshot: snapshot))
    }

    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<TuitWatchEntry>) -> Void) {
        let now = Date.now
        let snapshot = WidgetSnapshotStore.shared.load(area: nil) ?? .signedOut()
        let entry = TuitWatchEntry(date: now, snapshot: snapshot)
        let next = snapshot.nextRefreshDate(from: now)
        completion(Timeline(entries: [entry], policy: .after(next)))
    }
}

struct TuitComplicationWidget: Widget {
    static let kind = "TuitWatchComplication"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: TuitWatchProvider()) { entry in
            TuitComplicationView(entry: entry)
        }
        .configurationDisplayName("Tuit Now")
        .description("Urgent items and today's Tuit Now count on your watch face and Smart Stack.")
        .supportedFamilies([
            .accessoryCorner,
            .accessoryCircular,
            .accessoryRectangular,
            .accessoryInline,
        ])
    }
}

struct TuitComplicationView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TuitWatchEntry

    var body: some View {
        Group {
            switch family {
            case .accessoryCorner:
                TuitAccessoryCornerView(snapshot: entry.snapshot)
            case .accessoryCircular:
                TuitAccessoryCircularView(snapshot: entry.snapshot)
            case .accessoryRectangular:
                TuitAccessoryRectangularView(snapshot: entry.snapshot)
            case .accessoryInline:
                TuitAccessoryInlineView(snapshot: entry.snapshot)
            default:
                TuitAccessoryCircularView(snapshot: entry.snapshot)
            }
        }
        .containerBackground(.clear, for: .widget)
    }
}
