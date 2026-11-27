import SwiftUI

/// Everything you can see — regardless of whose turn it is, snooze, resting, or hidden-by-default
/// areas — filterable by state, area, and search text, paged 50 at a time.
struct TasksScreen: View {
    @Environment(Session.self) private var session
    @Environment(AppNavigation.self) private var navigation
    @State private var result: BrowseView?
    @State private var error: String?
    @State private var loaded = false
    @State private var limit = TasksScreen.pageSize

    static let pageSize = 50

    private var trimmedQuery: String { navigation.tasksQuery.trimmed }

    /// Explicit state persists across area switches and search; a fresh search without an explicit
    /// state spans all states (including closed), while browsing defaults to active.
    private var effectiveState: BrowseState {
        navigation.tasksExplicitState ?? (trimmedQuery.isEmpty ? .active : .all)
    }

    private var selectedArea: String? { navigation.tasksArea }

    private var namedAreas: [String] {
        var list = result?.areas ?? []
        if let selected = selectedArea, selected != "none", !list.contains(selected) {
            list.append(selected)
            list.sort()
        }
        return list
    }

    private var showAreaChips: Bool {
        !namedAreas.isEmpty || selectedArea != nil
    }

    private var showNoAreaChip: Bool {
        (result?.hasNoArea ?? false) || selectedArea == "none"
    }

    private var inSuffix: String {
        selectedArea.map { " in \(areaDisplayName($0))" } ?? ""
    }

    private var sectionHeader: String {
        guard let result, !result.items.isEmpty else { return "" }
        if !trimmedQuery.isEmpty {
            return "\(result.total) found\(inSuffix)"
        }
        return "\(result.total) \(result.total == 1 ? "task" : "tasks")\(inSuffix)"
    }

    private var emptyMessage: String {
        if !trimmedQuery.isEmpty {
            return "Nothing matches \"\(trimmedQuery)\"."
        }
        let word = effectiveState.emptyWord
        return "No\(word.isEmpty ? "" : " \(word)") tasks\(inSuffix)."
    }

    private var filterKey: String {
        "\(navigation.tasksExplicitState?.rawValue ?? "")|\(navigation.tasksArea ?? "")|\(navigation.tasksQuery)|\(navigation.tasksBrowseTick)"
    }

    var body: some View {
        @Bindable var navigation = navigation
        let items = result?.items ?? []
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    StateChips(selected: effectiveState) { state in
                        navigation.tasksExplicitState = state
                    }
                    if showAreaChips {
                        BrowseAreaChips(
                            areas: namedAreas,
                            hasNoArea: showNoAreaChip,
                            selected: $navigation.tasksArea
                        )
                    }
                }
            }
            .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0))
            .listRowBackground(Color.clear)

            Section {
                if loaded, items.isEmpty {
                    Text(emptyMessage).foregroundStyle(.secondary)
                }
                ForEach(items) { item in
                    NavigationLink(value: item.task.id) {
                        BrowseTaskRow(item: item, showArea: selectedArea == nil)
                    }
                    .contextMenu { TaskShareButton(task: item.task) }
                }
                if let moreCount = result?.moreCount, moreCount > 0 {
                    Button("Show \(min(moreCount, Self.pageSize)) more (\(moreCount) left)") {
                        Task { await more() }
                    }
                    .accessibilityIdentifier("tasks-show-more")
                }
            } header: {
                if !sectionHeader.isEmpty {
                    Text(sectionHeader)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(selectedArea.map { "Tasks · \(areaDisplayName($0))" } ?? "Tasks")
        .safeAreaInset(edge: .top) { OfflineBanner() }
        .searchable(
            text: $navigation.tasksQuery,
            prompt: selectedArea.map { "Search in \(areaDisplayName($0))…" } ?? "Titles, briefs, notes…"
        )
        .task(id: filterKey) {
            limit = Self.pageSize
            // Debounce typing; a newer keystroke cancels this task.
            if !navigation.tasksQuery.isEmpty { try? await Task.sleep(for: .milliseconds(300)) }
            guard !Task.isCancelled else { return }
            await load()
        }
        .refreshable { await load() }
        .onChange(of: session.changeTick) { Task { await load() } }
        .errorBanner($error)
        .navigationDestination(for: String.self) { id in TaskDetailScreen(taskId: id) }
    }

    private func buildQuery() -> [String: String] {
        var q: [String: String] = [:]
        if !trimmedQuery.isEmpty { q["q"] = trimmedQuery }
        if let explicit = navigation.tasksExplicitState { q["state"] = explicit.rawValue }
        if let area = selectedArea { q["area"] = area }
        if limit != Self.pageSize { q["limit"] = String(limit) }
        return q
    }

    private func load() async {
        guard let api = session.api else { return }
        let query = buildQuery()
        if let data = session.offlineStore?.cached("/browse", query: query),
           let cached = try? API.decoder.decode(BrowseView.self, from: data) {
            result = cached
            loaded = true
        }
        do {
            result = try await api.get("/browse", query: query)
            error = nil
            loaded = true
        } catch APIError.notFound {
            // Older server without GET /api/browse: fall back to GET /api/tasks.
            await loadFallback(api: api)
        } catch is CancellationError {
            return
        } catch {
            self.error = session.handle(error)
        }
    }

    private func loadFallback(api: API) async {
        var q: [String: String] = ["state": effectiveState.rawValue]
        if !trimmedQuery.isEmpty { q["q"] = trimmedQuery }
        if let area = selectedArea { q["area"] = area }
        do {
            let list: TaskList = try await api.get("/tasks", query: q)
            let matched = list.matching(state: effectiveState.rawValue, area: selectedArea)
            let ordered = matched.sorted { a, b in
                if a.isClosed != b.isClosed { return !a.isClosed }
                if a.isClosed { return (a.closedAt ?? a.updatedAt) > (b.closedAt ?? b.updatedAt) }
                return a.createdAt < b.createdAt
            }
            let page = ordered.prefix(limit).map { BrowseItem(task: $0, status: nil) }
            let areas: [String]
            let hasNoArea: Bool
            if let prior = result, selectedArea != nil || !trimmedQuery.isEmpty {
                areas = prior.areas
                hasNoArea = prior.hasNoArea
            } else {
                areas = Array(Set(matched.compactMap(\.area))).sorted()
                hasNoArea = matched.contains { $0.area == nil }
            }
            result = BrowseView(
                state: effectiveState.rawValue,
                area: selectedArea,
                q: trimmedQuery,
                items: Array(page),
                total: ordered.count,
                moreCount: max(0, ordered.count - page.count),
                areas: areas,
                hasNoArea: hasNoArea
            )
            error = nil
            loaded = true
        } catch is CancellationError {
            return
        } catch {
            self.error = session.handle(error)
        }
    }

    private func more() async {
        limit += Self.pageSize
        await load()
    }
}

struct StateChips: View {
    let selected: BrowseState
    let onSelect: (BrowseState) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(BrowseState.allCases) { state in
                    let on = selected == state
                    Button { onSelect(state) } label: {
                        Text(state.label)
                            .font(.subheadline.weight(.medium))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 7)
                            .background(on ? AnyShapeStyle(.tint) : AnyShapeStyle(.fill.tertiary), in: Capsule())
                            .foregroundStyle(on ? .white : .primary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("state-chip-\(state.rawValue)")
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
            .padding(.horizontal, 20)
        }
    }
}

struct BrowseAreaChips: View {
    let areas: [String]
    let hasNoArea: Bool
    @Binding var selected: String?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip("All areas", on: selected == nil, id: "area-chip-all") { selected = nil }
                ForEach(areas, id: \.self) { a in
                    chip("#\(a)", on: selected == a, id: "area-chip-\(a)") {
                        selected = selected == a ? nil : a
                    }
                }
                if hasNoArea {
                    chip("No area", on: selected == "none", id: "area-chip-none") {
                        selected = selected == "none" ? nil : "none"
                    }
                }
            }
            .padding(.horizontal, 20)
        }
    }

    private func chip(_ label: String, on: Bool, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.subheadline.weight(.medium))
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background(on ? AnyShapeStyle(.tint) : AnyShapeStyle(.fill.tertiary), in: Capsule())
                .foregroundStyle(on ? .white : .primary)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(id)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

struct BrowseTaskRow: View {
    @Environment(Session.self) private var session
    let item: BrowseItem
    var showArea = true

    private var task: TaskItem { item.task }
    private var status: TaskStatus? { item.status }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: icon)
                .foregroundStyle(iconTint)
                .imageScale(.medium)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    if status?.pinned == true {
                        Image(systemName: "pin.fill").font(.caption).foregroundStyle(.orange)
                    }
                    if task.isPrivate {
                        Image(systemName: "lock.fill").font(.caption).foregroundStyle(.secondary)
                    }
                    Text(task.title)
                        .foregroundStyle(task.isClosed ? .secondary : .primary)
                }
                HStack(spacing: 6) {
                    if showArea, let area = task.area {
                        Text("#\(area)").fontWeight(.medium).foregroundStyle(.tint)
                    }
                    Text(detail)
                        .foregroundStyle(isUrgent ? .red : .secondary)
                        .lineLimit(2)
                }
                .font(.caption)
            }
        }
        .padding(.vertical, 2)
    }

    private var isUrgent: Bool {
        !task.isClosed && status?.urgent != nil
    }

    private var icon: String {
        if task.isClosed {
            switch task.state {
            case "done": return "checkmark.circle.fill"
            case "expired": return "xmark.circle"
            case "shelved": return "archivebox"
            default: return "checkmark.circle"
            }
        }
        if isUrgent { return "exclamationmark.circle" }
        if task.recurrence != nil { return "arrow.triangle.2.circlepath" }
        if task.state == "waiting" { return "hourglass" }
        return "circle"
    }

    private var iconTint: Color {
        if task.isClosed { return task.state == "done" ? .green : .secondary }
        if isUrgent { return .red }
        if status?.routine?.stale == true && status?.available == true { return .orange }
        return .secondary
    }

    private var detail: String {
        if task.isClosed {
            let closedWhen = task.closedAt.map { "\(task.state) \(Fmt.ago($0))" } ?? task.state
            return [closedWhen, task.closeReason].filter { !$0.isEmpty }.joined(separator: " · ")
        }
        let who = session.actorName(task.nextActor)
        let statusLine = activeStatusText
        if !statusLine.isEmpty {
            return "\(statusLine) · next: \(who)"
        }
        if !task.nextAction.isEmpty {
            return "next: \(who) — \(task.nextAction)"
        }
        return "next: \(who)"
    }

    private var activeStatusText: String {
        if let urgent = status?.urgent, !urgent.isEmpty { return urgent }
        if let label = status?.label, !label.isEmpty { return label }
        if let held = status?.held, !held.isEmpty { return held }
        if let claim = task.claim { return "claimed by agent:\(claim.agent)" }
        if let snoozed = status?.snoozedUntil { return "snoozed until \(Fmt.when(snoozed))" }
        if status == nil, let w = task.waiting {
            return w.for.isEmpty ? "waiting" : "waiting for \(w.for)"
        }
        return ""
    }
}
