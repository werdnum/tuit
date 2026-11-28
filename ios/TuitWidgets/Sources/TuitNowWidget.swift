import AppIntents
import SwiftUI
import WidgetKit

nonisolated struct TuitNowEntry: TimelineEntry, Sendable {
    let date: Date
    let snapshot: WidgetNowSnapshot
    let isOfflineFallback: Bool
}

nonisolated struct TuitNowProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> TuitNowEntry {
        TuitNowEntry(date: .now, snapshot: .placeholder, isOfflineFallback: false)
    }

    func snapshot(for configuration: SelectNowAreaIntent, in context: Context) async -> TuitNowEntry {
        if context.isPreview {
            return TuitNowEntry(date: .now, snapshot: .placeholder, isOfflineFallback: false)
        }
        let area = await MainActor.run { configuration.area?.areaFilter }
        if let cached = WidgetSnapshotStore.shared.load(area: area) {
            return TuitNowEntry(date: .now, snapshot: cached, isOfflineFallback: false)
        }
        return await fetchEntry(area: area)
    }

    func timeline(for configuration: SelectNowAreaIntent, in context: Context) async -> Timeline<TuitNowEntry> {
        let area = await MainActor.run { configuration.area?.areaFilter }
        let entry = await fetchEntry(area: area)
        let next = entry.snapshot.nextRefreshDate(from: entry.date)
        return Timeline(entries: [entry], policy: .after(next))
    }

    @MainActor
    private func fetchEntry(area: String?) async -> TuitNowEntry {
        let cached = WidgetSnapshotStore.shared.load(area: area)
        let defaultCached = area == nil ? cached : WidgetSnapshotStore.shared.load(area: nil)

        guard let credentials = Credentials.stored() else {
            // If the main app wrote a signed-in snapshot (e.g. DEBUG env launch without Keychain),
            // honour it; otherwise show the signed-out prompt.
            if let cached, cached.signedIn {
                return TuitNowEntry(date: .now, snapshot: cached, isOfflineFallback: false)
            }
            return TuitNowEntry(date: .now, snapshot: .signedOut(), isOfflineFallback: false)
        }

        let serverString = TuitGroup.savedServerURL
            ?? cached?.serverURL
            ?? defaultCached?.serverURL
            ?? (Bundle.main.object(forInfoDictionaryKey: "TuitServer") as? String)

        guard let serverString, let base = URL(string: serverString) else {
            let fallback = cached ?? .signedOut()
            return TuitNowEntry(date: .now, snapshot: fallback, isOfflineFallback: true)
        }

        let api = API(base: base, credentials: credentials, offlineStore: nil)
        do {
            let query = area.map { ["area": $0] } ?? [:]
            let now: NowView = try await api.get("/now", query: query)
            let snapshot = WidgetNowSnapshot.from(
                now: now,
                serverURL: serverString,
                timezone: cached?.timezone ?? defaultCached?.timezone
            )
            WidgetSnapshotStore.shared.save(snapshot)
            return TuitNowEntry(date: .now, snapshot: snapshot, isOfflineFallback: false)
        } catch APIError.unauthenticated {
            return TuitNowEntry(date: .now, snapshot: .signedOut(), isOfflineFallback: false)
        } catch {
            if let cached {
                return TuitNowEntry(date: .now, snapshot: cached, isOfflineFallback: true)
            }
            let emptySignedIn = WidgetNowSnapshot(
                signedIn: true,
                serverURL: serverString,
                savedAt: .now,
                timezone: defaultCached?.timezone,
                area: area,
                areas: defaultCached?.areas ?? [],
                now: nil
            )
            return TuitNowEntry(date: .now, snapshot: emptySignedIn, isOfflineFallback: true)
        }
    }
}

struct TuitNowWidget: Widget {
    static let kind = "TuitNowWidget"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: Self.kind,
            intent: SelectNowAreaIntent.self,
            provider: TuitNowProvider()
        ) { entry in
            TuitNowWidgetView(entry: entry)
        }
        .configurationDisplayName("Tuit Now")
        .description("Urgent items, today's shortlist, and new handoffs at a glance.")
        .supportedFamilies([
            .systemSmall,
            .systemMedium,
            .systemLarge,
            .accessoryCircular,
            .accessoryRectangular,
            .accessoryInline,
        ])
    }
}

struct TuitNowWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TuitNowEntry

    var body: some View {
        switch family {
        case .accessoryCircular:
            TuitAccessoryCircularView(snapshot: entry.snapshot)
                .widgetURL(entry.snapshot.deepLinkURL)
                .containerBackground(.clear, for: .widget)
        case .accessoryRectangular:
            TuitAccessoryRectangularView(snapshot: entry.snapshot)
                .widgetURL(entry.snapshot.deepLinkURL)
                .containerBackground(.clear, for: .widget)
        case .accessoryInline:
            TuitAccessoryInlineView(snapshot: entry.snapshot)
                .widgetURL(entry.snapshot.deepLinkURL)
                .containerBackground(.clear, for: .widget)
        case .systemSmall:
            SmallNowView(entry: entry)
                .widgetURL(entry.snapshot.deepLinkURL)
                .containerBackground(.fill.tertiary, for: .widget)
        case .systemMedium:
            MediumNowView(entry: entry)
                .widgetURL(entry.snapshot.deepLinkURL)
                .containerBackground(.fill.tertiary, for: .widget)
        case .systemLarge:
            LargeNowView(entry: entry)
                .widgetURL(entry.snapshot.deepLinkURL)
                .containerBackground(.fill.tertiary, for: .widget)
        default:
            MediumNowView(entry: entry)
                .widgetURL(entry.snapshot.deepLinkURL)
                .containerBackground(.fill.tertiary, for: .widget)
        }
    }
}

// MARK: - Home Screen Views

private struct SmallNowView: View {
    let entry: TuitNowEntry
    private var snapshot: WidgetNowSnapshot { entry.snapshot }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 5) {
                Image(systemName: headerIcon)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(snapshot.urgentCount > 0 ? .red : Color("AccentColor"))
                Text(snapshot.shortAreaTitle)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(snapshot.urgentCount > 0 ? .red : .secondary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                if snapshot.signedIn, snapshot.now != nil {
                    countBadge
                }
            }

            if !snapshot.signedIn {
                Spacer(minLength: 0)
                stateMessage(icon: "person.crop.circle", title: "Sign in", subtitle: "Open Tuit to view Now")
                Spacer(minLength: 0)
            } else if snapshot.now == nil {
                Spacer(minLength: 0)
                stateMessage(icon: "arrow.triangle.2.circlepath", title: "Open Tuit", subtitle: "Waiting for Now list")
                Spacer(minLength: 0)
            } else if snapshot.isResting && snapshot.urgentCount == 0 {
                Spacer(minLength: 0)
                stateMessage(
                    icon: "cup.and.saucer.fill",
                    title: "Enough for now",
                    subtitle: snapshot.restingUntil.map { "Until \(Fmt.shortTime($0))" } ?? "List is resting"
                )
                Spacer(minLength: 0)
            } else {
                let rows = snapshot.displayRows(limit: 3, includeDonePlan: false, includeAlso: true)
                if rows.isEmpty {
                    Spacer(minLength: 0)
                    stateMessage(
                        icon: "checkmark.circle.fill",
                        title: "All clear",
                        subtitle: snapshot.waitingCount > 0 ? "\(snapshot.waitingCount) waiting" : "Nothing needs you"
                    )
                    Spacer(minLength: 0)
                } else {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(rows) { row in
                            HStack(alignment: .firstTextBaseline, spacing: 5) {
                                Image(systemName: rowIcon(row))
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundStyle(rowTint(row))
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(row.item.task.title)
                                        .font(.caption.weight(row.section == .urgent ? .semibold : .medium))
                                        .lineLimit(rows.count == 1 ? 3 : 1)
                                    if rows.count <= 2 && !row.item.why.isEmpty {
                                        Text(row.item.why)
                                            .font(.caption2)
                                            .foregroundStyle(row.item.urgent ? .red : .secondary)
                                            .lineLimit(1)
                                    }
                                }
                            }
                        }
                    }
                    Spacer(minLength: 0)
                    smallFooter(shown: rows.count)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private var headerIcon: String {
        if snapshot.urgentCount > 0 { return "exclamationmark.circle.fill" }
        if snapshot.isResting { return "cup.and.saucer.fill" }
        return "sun.max.fill"
    }

    @ViewBuilder
    private var countBadge: some View {
        if snapshot.urgentCount > 0 {
            Text("\(snapshot.urgentCount)")
                .font(.caption2.weight(.bold))
                .monospacedDigit()
                .foregroundStyle(.white)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(.red, in: Capsule())
        } else if snapshot.totalPlanCount > 0 && !snapshot.isResting {
            Text("\(snapshot.donePlanCount)/\(snapshot.totalPlanCount)")
                .font(.caption2.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(.secondary)
        } else if snapshot.remainingCount > 0 {
            Text("\(snapshot.remainingCount)")
                .font(.caption2.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func smallFooter(shown: Int) -> some View {
        let extra = max(0, snapshot.remainingCount - shown)
        HStack(spacing: 4) {
            if snapshot.isResting && snapshot.urgentCount > 0 {
                Text("Resting · urgent only")
            } else if extra > 0 {
                Text("+\(extra) more")
            } else if snapshot.waitingCount > 0 {
                Text("\(snapshot.waitingCount) waiting")
            } else if entry.isOfflineFallback {
                Text("Saved")
            }
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }

    private func stateMessage(icon: String, title: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(Color("AccentColor"))
            Text(title)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
            Text(subtitle)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
    }
}

private struct MediumNowView: View {
    let entry: TuitNowEntry
    private var snapshot: WidgetNowSnapshot { entry.snapshot }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            WidgetHeaderBar(snapshot: snapshot, isOfflineFallback: entry.isOfflineFallback)

            if !snapshot.signedIn {
                Spacer(minLength: 0)
                EmptyWidgetBody(
                    icon: "person.crop.circle",
                    title: "Sign in to Tuit",
                    subtitle: "Open the app to sign in and see your Now list here."
                )
                Spacer(minLength: 0)
            } else if snapshot.now == nil {
                Spacer(minLength: 0)
                EmptyWidgetBody(
                    icon: "arrow.triangle.2.circlepath",
                    title: "Open Tuit to sync",
                    subtitle: "Your Now list will appear here automatically."
                )
                Spacer(minLength: 0)
            } else if snapshot.isResting && snapshot.urgentCount == 0 {
                Spacer(minLength: 0)
                EmptyWidgetBody(
                    icon: "cup.and.saucer.fill",
                    title: "Enough for now",
                    subtitle: snapshot.restingUntil.map {
                        "Resting until \(Fmt.shortTime($0)). Urgent items still show."
                    } ?? "Your list is resting. Urgent items still show."
                )
                Spacer(minLength: 0)
            } else {
                let rows = snapshot.displayRows(limit: 4, includeDonePlan: false, includeAlso: true)
                if rows.isEmpty {
                    Spacer(minLength: 0)
                    EmptyWidgetBody(
                        icon: "checkmark.circle.fill",
                        title: "Nothing needs you right now",
                        subtitle: snapshot.waitingCount > 0
                            ? "\(snapshot.waitingCount) waiting on something else."
                            : "Enjoy the calm."
                    )
                    Spacer(minLength: 0)
                } else {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(rows) { row in
                            WidgetTaskRowView(row: row, area: snapshot.area, compact: true)
                        }
                    }
                    Spacer(minLength: 0)
                    let extra = max(0, snapshot.remainingCount - rows.count)
                    if extra > 0 || (snapshot.isResting && snapshot.urgentCount > 0) {
                        HStack {
                            if snapshot.isResting {
                                Text("Enough for now · showing urgent")
                            } else {
                                Text("+\(extra) more on Now")
                            }
                            Spacer()
                            if snapshot.waitingCount > 0 {
                                Text("\(snapshot.waitingCount) waiting")
                            }
                        }
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

private struct LargeNowView: View {
    let entry: TuitNowEntry
    private var snapshot: WidgetNowSnapshot { entry.snapshot }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            WidgetHeaderBar(snapshot: snapshot, isOfflineFallback: entry.isOfflineFallback)

            if !snapshot.signedIn {
                Spacer(minLength: 0)
                EmptyWidgetBody(
                    icon: "person.crop.circle",
                    title: "Sign in to Tuit",
                    subtitle: "Open the app to sign in and see your Now list here."
                )
                Spacer(minLength: 0)
            } else if snapshot.now == nil {
                Spacer(minLength: 0)
                EmptyWidgetBody(
                    icon: "arrow.triangle.2.circlepath",
                    title: "Open Tuit to sync",
                    subtitle: "Your Now list will appear here automatically."
                )
                Spacer(minLength: 0)
            } else if snapshot.isResting && snapshot.urgentCount == 0 {
                Spacer(minLength: 0)
                EmptyWidgetBody(
                    icon: "cup.and.saucer.fill",
                    title: "Enough for now",
                    subtitle: snapshot.restingUntil.map {
                        "Your list is resting until \(Fmt.shortTime($0)). Urgent items still show."
                    } ?? "Your list is resting. Urgent items still show."
                )
                Spacer(minLength: 0)
            } else {
                let rows = snapshot.displayRows(limit: 8, includeDonePlan: true, includeAlso: true)
                if rows.isEmpty {
                    Spacer(minLength: 0)
                    EmptyWidgetBody(
                        icon: "checkmark.circle.fill",
                        title: "Nothing needs you right now",
                        subtitle: snapshot.waitingCount > 0
                            ? "\(snapshot.waitingCount) waiting on something else."
                            : "Capture something anytime with + above."
                    )
                    Spacer(minLength: 0)
                } else {
                    VStack(alignment: .leading, spacing: 7) {
                        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                            if shouldShowSectionHeader(at: index, in: rows) {
                                Text(sectionTitle(for: row.section))
                                    .font(.caption2.weight(.semibold))
                                    .textCase(.uppercase)
                                    .foregroundStyle(row.section == .urgent ? .red : .secondary)
                                    .padding(.top, index == 0 ? 0 : 2)
                            }
                            WidgetTaskRowView(row: row, area: snapshot.area, compact: false)
                        }
                    }
                    Spacer(minLength: 0)
                    HStack {
                        if snapshot.isResting {
                            Text("Enough for now · urgent only")
                        } else {
                            let shownOpen = rows.filter { !$0.done }.count
                            let extra = max(0, snapshot.remainingCount - shownOpen)
                            if extra > 0 {
                                Text("+\(extra) more on Now")
                            } else if snapshot.totalPlanCount > 0 {
                                Text("\(snapshot.donePlanCount) of \(snapshot.totalPlanCount) done today")
                            }
                        }
                        Spacer()
                        if snapshot.waitingCount > 0 {
                            Text("\(snapshot.waitingCount) waiting")
                        }
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private func shouldShowSectionHeader(at index: Int, in rows: [WidgetNowRow]) -> Bool {
        if index == 0 { return true }
        return rows[index - 1].section != rows[index].section
    }

    private func sectionTitle(for section: WidgetNowRow.Section) -> String {
        switch section {
        case .urgent: "Urgent"
        case .plan: "Today"
        case .newItem: "New since this morning"
        case .also: "Everything else"
        }
    }
}

// MARK: - Shared Home Screen Components

private struct WidgetHeaderBar: View {
    let snapshot: WidgetNowSnapshot
    let isOfflineFallback: Bool

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: snapshot.urgentCount > 0 ? "exclamationmark.circle.fill" : "sun.max.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(snapshot.urgentCount > 0 ? .red : Color("AccentColor"))
            Text(snapshot.areaTitle)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
            if snapshot.urgentCount > 0 {
                Text("\(snapshot.urgentCount) urgent")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.red, in: Capsule())
            } else if snapshot.signedIn, snapshot.totalPlanCount > 0, !snapshot.isResting {
                Text("\(snapshot.donePlanCount)/\(snapshot.totalPlanCount)")
                    .font(.caption2.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.fill.secondary, in: Capsule())
            }
            if isOfflineFallback {
                Image(systemName: "wifi.slash")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            if snapshot.signedIn {
                Link(destination: snapshot.captureURL) {
                    Image(systemName: "plus.circle.fill")
                        .font(.body)
                        .foregroundStyle(Color("AccentColor"))
                }
                .accessibilityLabel("Capture in Tuit")
            }
        }
    }
}

private struct WidgetTaskRowView: View {
    let row: WidgetNowRow
    let area: String?
    let compact: Bool

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            if row.canQuickComplete {
                Button(intent: CompleteTaskFromWidgetIntent(
                    taskID: row.item.task.id,
                    expectedRevision: row.item.task.revision,
                    area: area
                )) {
                    Image(systemName: rowIcon(row))
                        .font(.system(size: compact ? 15 : 16, weight: .medium))
                        .foregroundStyle(rowTint(row))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Mark \(row.item.task.title) done")
            } else {
                Image(systemName: row.done ? "checkmark.circle.fill" : rowIcon(row))
                    .font(.system(size: compact ? 15 : 16, weight: .medium))
                    .foregroundStyle(row.done ? .green : rowTint(row))
            }

            Link(destination: WidgetNowSnapshot.taskURL(id: row.item.task.id)) {
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 4) {
                        if row.item.pinned && !row.done {
                            Image(systemName: "pin.fill")
                                .font(.caption2)
                                .foregroundStyle(.orange)
                        }
                        Text(row.item.task.title)
                            .font(.subheadline.weight(row.section == .urgent ? .semibold : .regular))
                            .strikethrough(row.done)
                            .foregroundStyle(row.done ? .secondary : .primary)
                            .lineLimit(1)
                    }
                    if !compact && !row.done {
                        let subtitle = rowSubtitle(row)
                        if !subtitle.isEmpty {
                            Text(subtitle)
                                .font(.caption2)
                                .foregroundStyle(row.item.urgent ? .red : .secondary)
                                .lineLimit(1)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            if compact, !row.done, !row.item.why.isEmpty {
                Text(row.item.why)
                    .font(.caption2)
                    .foregroundStyle(row.item.urgent ? .red : .secondary)
                    .lineLimit(1)
                    .layoutPriority(-1)
            }
        }
    }

    private func rowSubtitle(_ row: WidgetNowRow) -> String {
        var parts: [String] = []
        if let taskArea = row.item.task.area, area == nil {
            parts.append("#\(taskArea)")
        }
        if !row.item.why.isEmpty {
            parts.append(row.item.why)
        }
        return parts.joined(separator: " · ")
    }
}

private struct EmptyWidgetBody: View {
    let icon: String
    let title: String
    let subtitle: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.title2)
                .foregroundStyle(Color("AccentColor"))
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
    }
}

private func rowIcon(_ row: WidgetNowRow) -> String {
    if row.done { return "checkmark.circle.fill" }
    if row.item.urgent { return "exclamationmark.circle" }
    if row.item.task.recurrence != nil { return "arrow.triangle.2.circlepath" }
    if row.item.task.state == "waiting" { return "hourglass" }
    return "circle"
}

private func rowTint(_ row: WidgetNowRow) -> Color {
    if row.done { return .green }
    if row.item.urgent { return .red }
    if row.item.stale { return .orange }
    return .secondary
}
