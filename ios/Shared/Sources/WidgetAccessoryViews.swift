import SwiftUI
import WidgetKit

/// Shared Lock Screen (iOS) and watch face (watchOS) complication views for Tuit Now.
struct TuitAccessoryCircularView: View {
    let snapshot: WidgetNowSnapshot

    var body: some View {
        if !snapshot.signedIn {
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 1) {
                    Image(systemName: "sun.max")
                        .font(.system(size: 16, weight: .semibold))
                    Text("Sign in")
                        .font(.system(size: 9, weight: .medium))
                }
            }
        } else if snapshot.urgentCount > 0 {
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Image(systemName: "exclamationmark.circle.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.red)
                        .widgetAccentable()
                    Text("\(snapshot.urgentCount)")
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .minimumScaleFactor(0.6)
                }
            }
            .accessibilityLabel("\(snapshot.urgentCount) urgent in Tuit Now")
        } else if snapshot.isResting {
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 1) {
                    Image(systemName: "cup.and.saucer.fill")
                        .font(.system(size: 16, weight: .medium))
                        .widgetAccentable()
                    Text("Rest")
                        .font(.system(size: 9, weight: .medium))
                }
            }
            .accessibilityLabel("Tuit Now resting")
        } else if snapshot.totalPlanCount > 0 {
            let done = Double(snapshot.donePlanCount)
            let total = Double(max(1, snapshot.totalPlanCount))
            let remaining = snapshot.remainingCount
            Gauge(value: done, in: 0...total) {
                Image(systemName: "sun.max.fill")
            } currentValueLabel: {
                if remaining == 0 {
                    Image(systemName: "checkmark")
                        .font(.system(size: 15, weight: .bold))
                        .widgetAccentable()
                } else {
                    Text("\(remaining)")
                        .font(.system(size: 18, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .minimumScaleFactor(0.6)
                }
            }
            .gaugeStyle(.accessoryCircular)
            .tint(Color("AccentColor"))
            .accessibilityLabel("\(remaining) remaining in Tuit Now, \(snapshot.donePlanCount) of \(snapshot.totalPlanCount) done")
        } else {
            let remaining = snapshot.remainingCount
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    if remaining == 0 {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 22, weight: .semibold))
                            .widgetAccentable()
                    } else {
                        Text("\(remaining)")
                            .font(.system(size: 20, weight: .bold, design: .rounded))
                            .monospacedDigit()
                            .minimumScaleFactor(0.6)
                        Text("NOW")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .accessibilityLabel(remaining == 0 ? "Tuit Now all clear" : "\(remaining) in Tuit Now")
        }
    }
}

struct TuitAccessoryRectangularView: View {
    let snapshot: WidgetNowSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            header
            if !snapshot.signedIn {
                Text("Sign in to Tuit")
                    .font(.headline)
                    .lineLimit(1)
                Text("Open Tuit on iPhone")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            } else if snapshot.now == nil {
                Text("Open Tuit to sync")
                    .font(.headline)
                    .lineLimit(1)
                Text("Waiting for Now list")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            } else if snapshot.isResting && snapshot.urgentCount == 0 {
                Text("Enough for now")
                    .font(.headline)
                    .lineLimit(1)
                if let until = snapshot.restingUntil {
                    Text("Until \(Fmt.shortTime(until))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                } else {
                    Text("List is resting")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            } else if let top = snapshot.topRow {
                let rows = snapshot.displayRows(limit: 2, includeDonePlan: false, includeAlso: true)
                Text(top.item.task.title)
                    .font(.headline)
                    .lineLimit(1)
                if rows.count > 1 && !top.item.urgent {
                    HStack(spacing: 4) {
                        Text(rows[1].item.task.title)
                            .lineLimit(1)
                        let extra = max(0, snapshot.remainingCount - 2)
                        if extra > 0 {
                            Text("+\(extra)")
                                .fontWeight(.semibold)
                                .monospacedDigit()
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                } else if !top.item.why.isEmpty {
                    Text(top.item.why)
                        .font(.caption)
                        .foregroundStyle(top.item.urgent ? .red : .secondary)
                        .lineLimit(1)
                } else if let area = top.item.task.area {
                    Text("#\(area)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                } else if snapshot.remainingCount > 1 {
                    Text("+\(snapshot.remainingCount - 1) more")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            } else {
                Text("All clear")
                    .font(.headline)
                    .lineLimit(1)
                Text(snapshot.waitingCount > 0 ? "\(snapshot.waitingCount) waiting" : "Nothing needs you")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private var header: some View {
        HStack(spacing: 4) {
            Image(systemName: headerIcon)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(snapshot.urgentCount > 0 ? .red : Color("AccentColor"))
                .widgetAccentable()
            Text(headerTitle)
                .font(.caption2.weight(.semibold))
                .textCase(.uppercase)
                .foregroundStyle(snapshot.urgentCount > 0 ? .red : .secondary)
                .lineLimit(1)
            Spacer(minLength: 2)
            if let badge = headerBadge {
                Text(badge)
                    .font(.caption2.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var headerIcon: String {
        if snapshot.urgentCount > 0 { return "exclamationmark.circle.fill" }
        if snapshot.isResting { return "cup.and.saucer.fill" }
        if snapshot.signedIn && snapshot.now != nil && snapshot.remainingCount == 0 { return "checkmark.circle.fill" }
        return "sun.max.fill"
    }

    private var headerTitle: String {
        if snapshot.urgentCount > 0 { return "Urgent" }
        if let area = snapshot.area { return areaDisplayName(area) }
        return "Tuit Now"
    }

    private var headerBadge: String? {
        guard snapshot.signedIn, snapshot.now != nil else { return nil }
        if snapshot.urgentCount > 0 { return "\(snapshot.urgentCount)" }
        if snapshot.totalPlanCount > 0 && !snapshot.isResting {
            return "\(snapshot.donePlanCount)/\(snapshot.totalPlanCount)"
        }
        if snapshot.remainingCount > 0 { return "\(snapshot.remainingCount)" }
        return nil
    }
}

struct TuitAccessoryInlineView: View {
    let snapshot: WidgetNowSnapshot

    var body: some View {
        Label {
            Text(snapshot.inlineSummary)
        } icon: {
            Image(systemName: iconName)
        }
    }

    private var iconName: String {
        if !snapshot.signedIn { return "sun.max" }
        if snapshot.urgentCount > 0 { return "exclamationmark.circle.fill" }
        if snapshot.isResting { return "cup.and.saucer.fill" }
        if snapshot.now != nil && snapshot.remainingCount == 0 { return "checkmark.circle.fill" }
        return "sun.max.fill"
    }
}

#if os(watchOS)
struct TuitAccessoryCornerView: View {
    let snapshot: WidgetNowSnapshot

    var body: some View {
        cornerGlyph
            .widgetCurvesContent()
            .widgetLabel {
                if !snapshot.isResting && snapshot.urgentCount == 0 && snapshot.totalPlanCount > 0 {
                    Gauge(
                        value: Double(snapshot.donePlanCount),
                        in: 0...Double(max(1, snapshot.totalPlanCount))
                    ) {
                        Text(snapshot.cornerLabel)
                    } currentValueLabel: {
                        Text("\(snapshot.donePlanCount)")
                    } minimumValueLabel: {
                        Text("0")
                    } maximumValueLabel: {
                        Text("\(snapshot.totalPlanCount)")
                    }
                    .tint(Color("AccentColor"))
                } else {
                    Text(snapshot.cornerLabel)
                }
            }
    }

    @ViewBuilder
    private var cornerGlyph: some View {
        if !snapshot.signedIn {
            Image(systemName: "sun.max")
                .font(.system(size: 20, weight: .semibold))
                .widgetAccentable()
        } else if snapshot.urgentCount > 0 {
            Text("\(snapshot.urgentCount)")
                .font(.system(size: 24, weight: .bold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(.red)
                .widgetAccentable()
        } else if snapshot.isResting {
            Image(systemName: "cup.and.saucer.fill")
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(Color("AccentColor"))
                .widgetAccentable()
        } else if snapshot.remainingCount == 0 && snapshot.now != nil {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(Color("AccentColor"))
                .widgetAccentable()
        } else {
            Text("\(snapshot.remainingCount)")
                .font(.system(size: 24, weight: .bold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(Color("AccentColor"))
                .widgetAccentable()
        }
    }
}
#endif
