import Foundation

/// A single row projected from `NowView` for widgets and watch complications.
nonisolated struct WidgetNowRow: Codable, Hashable, Identifiable, Sendable {
    enum Section: String, Codable, Hashable, Sendable {
        case urgent
        case plan
        case newItem
        case also
    }

    var id: String { item.id }
    var item: QueueItem
    var section: Section
    var done: Bool

    var canQuickComplete: Bool {
        !done && item.task.openPartCount == 0 && !item.task.isClosed
    }
}

/// Snapshot of Tuit Now shared with iOS widgets and synced to Apple Watch.
/// All ranking, urgency and labels come verbatim from the server's `NowView`.
nonisolated struct WidgetNowSnapshot: Codable, Hashable, Sendable {
    var signedIn: Bool
    var serverURL: String?
    var savedAt: Date
    var timezone: String?
    var area: String?
    var areas: [String]
    var now: NowView?

    static func signedOut(savedAt: Date = .now) -> WidgetNowSnapshot {
        WidgetNowSnapshot(
            signedIn: false,
            serverURL: nil,
            savedAt: savedAt,
            timezone: nil,
            area: nil,
            areas: [],
            now: nil
        )
    }

    static func from(
        now: NowView,
        serverURL: String?,
        timezone: String?,
        savedAt: Date = .now
    ) -> WidgetNowSnapshot {
        WidgetNowSnapshot(
            signedIn: true,
            serverURL: serverURL,
            savedAt: savedAt,
            timezone: timezone,
            area: now.area,
            areas: now.areas,
            now: now
        )
    }

    // MARK: Projections

    var isResting: Bool {
        now?.enoughUntil != nil
    }

    var restingUntil: String? {
        now?.enoughUntil
    }

    var urgentItems: [QueueItem] {
        now?.urgent ?? []
    }

    var urgentCount: Int {
        urgentItems.count
    }

    var totalPlanCount: Int {
        now?.plan.count ?? 0
    }

    var donePlanCount: Int {
        now?.plan.filter(\.done).count ?? 0
    }

    var openPlanRows: [NowView.PlanRow] {
        now?.plan.filter { !$0.done } ?? []
    }

    var newItems: [QueueItem] {
        now?.newItems ?? []
    }

    var alsoItems: [QueueItem] {
        now?.also ?? []
    }

    var waitingCount: Int {
        now?.waitingCount ?? 0
    }

    var restingCount: Int {
        now?.restingCount ?? 0
    }

    /// Deduplicated open items that currently deserve attention.
    /// During "Enough for now", only urgent items surface.
    var actionableRows: [WidgetNowRow] {
        guard let now else { return [] }
        var seen = Set<String>()
        var rows: [WidgetNowRow] = []

        for item in now.urgent where seen.insert(item.id).inserted {
            rows.append(WidgetNowRow(item: item, section: .urgent, done: false))
        }
        guard now.enoughUntil == nil else { return rows }

        for planRow in now.plan where !planRow.done && seen.insert(planRow.item.id).inserted {
            rows.append(WidgetNowRow(item: planRow.item, section: .plan, done: false))
        }
        for item in now.newItems where seen.insert(item.id).inserted {
            rows.append(WidgetNowRow(item: item, section: .newItem, done: false))
        }
        if now.plan.isEmpty && now.newItems.isEmpty {
            for item in now.also where seen.insert(item.id).inserted {
                rows.append(WidgetNowRow(item: item, section: .also, done: false))
            }
        }
        return rows
    }

    /// Rows for list-style widgets. Includes completed plan items when `includeDonePlan` is true
    /// and appends `also` items if space remains.
    func displayRows(limit: Int, includeDonePlan: Bool = false, includeAlso: Bool = true) -> [WidgetNowRow] {
        guard let now, limit > 0 else { return [] }
        var seen = Set<String>()
        var rows: [WidgetNowRow] = []

        func append(_ row: WidgetNowRow) {
            guard rows.count < limit, seen.insert(row.id).inserted else { return }
            rows.append(row)
        }

        for item in now.urgent {
            append(WidgetNowRow(item: item, section: .urgent, done: false))
        }
        guard now.enoughUntil == nil else { return rows }

        for planRow in now.plan where !planRow.done {
            append(WidgetNowRow(item: planRow.item, section: .plan, done: false))
        }
        for item in now.newItems {
            append(WidgetNowRow(item: item, section: .newItem, done: false))
        }
        if includeDonePlan {
            for planRow in now.plan where planRow.done {
                append(WidgetNowRow(item: planRow.item, section: .plan, done: true))
            }
        }
        if includeAlso {
            for item in now.also {
                append(WidgetNowRow(item: item, section: .also, done: false))
            }
        }
        return rows
    }

    /// Total count of remaining items on Now for compact badges and complications.
    var remainingCount: Int {
        guard let now else { return 0 }
        if now.enoughUntil != nil {
            return now.urgent.count
        }
        let open = actionableRows.count
        if open > 0 { return open }
        return now.also.count + now.moreCount
    }

    /// Progress fraction for Today's sticky plan (nil when there is no plan or resting).
    var planProgress: Double? {
        guard !isResting, totalPlanCount > 0 else { return nil }
        return Double(donePlanCount) / Double(totalPlanCount)
    }

    var topRow: WidgetNowRow? {
        actionableRows.first
    }

    var areaTitle: String {
        if let area { return "Now · \(areaDisplayName(area))" }
        return "Now"
    }

    var shortAreaTitle: String {
        if let area { return areaDisplayName(area) }
        return "Now"
    }

    var deepLinkURL: URL {
        if let area, let encoded = area.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
            return URL(string: "tuit://now?area=\(encoded)")!
        }
        return URL(string: "tuit://now")!
    }

    var captureURL: URL {
        if let area, let encoded = area.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
            return URL(string: "tuit://capture?area=\(encoded)")!
        }
        return URL(string: "tuit://capture")!
    }

    static func taskURL(id: String) -> URL {
        URL(string: "tuit://tasks/\(id)")!
    }

    /// Concise single-line copy for Lock Screen and Apple Watch inline complications.
    var inlineSummary: String {
        guard signedIn else { return "Sign in to Tuit" }
        guard now != nil else { return "Open Tuit" }
        if let urgent = urgentItems.first {
            return urgentCount == 1
                ? "Urgent: \(urgent.task.title)"
                : "\(urgentCount) urgent · \(urgent.task.title)"
        }
        if isResting {
            return "Enough for now"
        }
        if let top = topRow {
            let count = remainingCount
            return count > 1 ? "\(count) · \(top.item.task.title)" : top.item.task.title
        }
        return "Tuit · All clear"
    }

    /// Short curved label for Apple Watch corner complications.
    var cornerLabel: String {
        guard signedIn else { return "Sign in" }
        guard now != nil else { return "Tuit Now" }
        if urgentCount > 0 {
            return urgentCount == 1 ? "1 urgent" : "\(urgentCount) urgent"
        }
        if isResting {
            return "Resting"
        }
        if totalPlanCount > 0 {
            return "\(donePlanCount)/\(totalPlanCount) done"
        }
        if remainingCount == 0 {
            return "All clear"
        }
        return "Tuit Now"
    }

    /// Compact copy of the snapshot trimmed for WatchConnectivity's 65 KB applicationContext budget.
    func trimmedForWatch(maxAlso: Int = 12, maxBriefLength: Int = 300) -> WidgetNowSnapshot {
        guard var now else { return self }
        func trimTask(_ item: QueueItem) -> QueueItem {
            var copy = item
            if copy.task.brief.count > maxBriefLength {
                copy.task.brief = String(copy.task.brief.prefix(maxBriefLength)) + "…"
            }
            copy.task.attachments = []
            return copy
        }
        now.urgent = now.urgent.map(trimTask)
        now.plan = now.plan.map { NowView.PlanRow(item: trimTask($0.item), done: $0.done) }
        now.newItems = now.newItems.map(trimTask)
        let droppedAlso = max(0, now.also.count - maxAlso)
        now.also = Array(now.also.prefix(maxAlso)).map(trimTask)
        now.moreCount += droppedAlso
        var copy = self
        copy.now = now
        return copy
    }

    /// Next sensible WidgetKit refresh time: 15 minutes from `date`, or earlier if
    /// "Enough for now" expires sooner.
    func nextRefreshDate(from date: Date = .now) -> Date {
        let standard = date.addingTimeInterval(15 * 60)
        if let until = restingUntil.flatMap(Fmt.date), until > date, until < standard {
            return until.addingTimeInterval(5)
        }
        return standard
    }

    /// Placeholder data for Xcode previews and WidgetKit gallery snapshots.
    static var placeholder: WidgetNowSnapshot {
        let sampleTask1 = TaskItem(
            id: "preview-1",
            title: "Ring the vet about Milo",
            brief: "",
            nextAction: "Call before 5pm",
            doneMeans: "",
            owner: "alex",
            visibility: "household",
            nextActor: .user("alex"),
            actorSince: "2026-10-01T00:00:00Z",
            state: "open",
            closeReason: "",
            closedAt: nil,
            waiting: nil,
            availableFrom: nil,
            target: nil,
            deadline: .date("2026-10-02"),
            expires: nil,
            area: "home",
            requires: [],
            prefers: [],
            recurrence: nil,
            attachments: [],
            openParts: nil,
            lastDoneAt: nil,
            lastSkipAt: nil,
            claim: nil,
            revision: 1,
            createdAt: "2026-10-01T00:00:00Z",
            updatedAt: "2026-10-01T00:00:00Z",
            createdBy: Author(user: "alex", agent: nil)
        )
        let sampleTask2 = TaskItem(
            id: "preview-2",
            title: "Water the plants",
            brief: "",
            nextAction: "",
            doneMeans: "",
            owner: "alex",
            visibility: "household",
            nextActor: .user("alex"),
            actorSince: "2026-10-01T00:00:00Z",
            state: "open",
            closeReason: "",
            closedAt: nil,
            waiting: nil,
            availableFrom: nil,
            target: nil,
            deadline: nil,
            expires: nil,
            area: "home",
            requires: [],
            prefers: [],
            recurrence: Recurrence(mode: "since_done", everyDays: 3),
            attachments: [],
            openParts: nil,
            lastDoneAt: nil,
            lastSkipAt: nil,
            claim: nil,
            revision: 1,
            createdAt: "2026-10-01T00:00:00Z",
            updatedAt: "2026-10-01T00:00:00Z",
            createdBy: Author(user: "alex", agent: nil)
        )
        let sampleTask3 = TaskItem(
            id: "preview-3",
            title: "Check solar inverter logs",
            brief: "",
            nextAction: "",
            doneMeans: "",
            owner: "alex",
            visibility: "household",
            nextActor: .user("alex"),
            actorSince: "2026-10-01T00:00:00Z",
            state: "open",
            closeReason: "",
            closedAt: nil,
            waiting: nil,
            availableFrom: nil,
            target: nil,
            deadline: nil,
            expires: nil,
            area: "tuit",
            requires: [],
            prefers: [],
            recurrence: nil,
            attachments: [],
            openParts: nil,
            lastDoneAt: nil,
            lastSkipAt: nil,
            claim: nil,
            revision: 1,
            createdAt: "2026-10-01T00:00:00Z",
            updatedAt: "2026-10-01T00:00:00Z",
            createdBy: Author(user: "alex", agent: nil)
        )
        let now = NowView(
            date: "2026-10-01",
            area: nil,
            areaHidden: nil,
            areaOtherCount: nil,
            areas: ["home", "tuit"],
            plan: [
                NowView.PlanRow(
                    item: QueueItem(
                        task: sampleTask2,
                        why: "last done 4 days ago",
                        label: "last done 4 days ago",
                        urgent: false,
                        stale: false,
                        snoozedUntil: nil,
                        pinned: false
                    ),
                    done: false
                ),
                NowView.PlanRow(
                    item: QueueItem(
                        task: sampleTask3,
                        why: "target today",
                        label: "target today",
                        urgent: false,
                        stale: false,
                        snoozedUntil: nil,
                        pinned: false
                    ),
                    done: true
                ),
            ],
            newItems: [],
            also: [],
            moreCount: 0,
            urgent: [
                QueueItem(
                    task: sampleTask1,
                    why: "deadline tomorrow",
                    label: "deadline tomorrow",
                    urgent: true,
                    stale: false,
                    snoozedUntil: nil,
                    pinned: false
                )
            ],
            enoughUntil: nil,
            waitingCount: 1,
            restingCount: 0,
            away: nil
        )
        return WidgetNowSnapshot.from(now: now, serverURL: nil, timezone: "Australia/Sydney")
    }
}

/// Reads and writes `WidgetNowSnapshot` JSON files inside the App Group container.
nonisolated struct WidgetSnapshotStore: Sendable {
    let directory: URL

    static let shared = WidgetSnapshotStore(directory: TuitGroup.containerURL)

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    func fileURL(area: String? = nil) -> URL {
        if let area, !area.isEmpty {
            let safe = normalizeAreaFilter(area)
                .replacingOccurrences(of: "[^a-z0-9_-]", with: "_", options: .regularExpression)
            return directory.appending(path: "widget-now-area-\(safe).json")
        }
        return directory.appending(path: "widget-now.json")
    }

    func load(area: String? = nil) -> WidgetNowSnapshot? {
        let url = fileURL(area: area)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? Self.decoder.decode(WidgetNowSnapshot.self, from: data)
    }

    func save(_ snapshot: WidgetNowSnapshot) {
        let url = fileURL(area: snapshot.area)
        do {
            var dir = directory
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? dir.setResourceValues(values)
            let data = try Self.encoder.encode(snapshot)
            try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            // Best-effort cache write; widgets fall back gracefully.
        }
    }

    func clearAll() {
        guard let items = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) else {
            return
        }
        for item in items where item.lastPathComponent.hasPrefix("widget-now") {
            try? FileManager.default.removeItem(at: item)
        }
    }

    /// All known areas from the default unfiltered Now snapshot, for widget configuration pickers.
    func knownAreas() -> [String] {
        load(area: nil)?.areas ?? []
    }
}

/// Wire wrapper for WatchConnectivity dictionaries (`applicationContext`, `userInfo`, `sendMessage`).
nonisolated enum WatchWire {
    static let snapshotKey = "tuit_now_snapshot_json"
    static let commandKey = "tuit_watch_command"
    static let taskIDKey = "tuit_task_id"
    static let revisionKey = "tuit_expected_revision"
    static let errorKey = "tuit_error"

    static let commandRefresh = "refresh"
    static let commandComplete = "complete"

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    static func encode(_ snapshot: WidgetNowSnapshot) -> [String: Any]? {
        let compact = snapshot.trimmedForWatch()
        guard let data = try? encoder.encode(compact) else { return nil }
        return [snapshotKey: data]
    }

    static func decode(_ payload: [String: Any]) -> WidgetNowSnapshot? {
        guard let data = payload[snapshotKey] as? Data else { return nil }
        return try? decoder.decode(WidgetNowSnapshot.self, from: data)
    }
}
