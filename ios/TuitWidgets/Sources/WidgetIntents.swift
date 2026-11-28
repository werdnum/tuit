import AppIntents
import Foundation
import WidgetKit

/// Area choice for the configurable Tuit Now widget ("All areas" or a specific `#area`).
nonisolated struct AreaEntity: AppEntity, Hashable, Sendable {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Area"
    static let defaultQuery = AreaEntityQuery()

    /// Empty string represents "All areas"; any other value is the normalized area slug.
    let id: String
    let name: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }

    static let all = AreaEntity(id: "", name: "All areas")

    var areaFilter: String? {
        id.isEmpty ? nil : id
    }
}

nonisolated struct AreaEntityQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [AreaEntity] {
        let available = allOptions()
        return identifiers.compactMap { id in
            if id.isEmpty { return .all }
            return available.first(where: { $0.id == id })
                ?? AreaEntity(id: id, name: areaDisplayName(id))
        }
    }

    func suggestedEntities() async throws -> [AreaEntity] {
        allOptions()
    }

    func defaultResult() async -> AreaEntity? {
        .all
    }

    private func allOptions() -> [AreaEntity] {
        let areas = WidgetSnapshotStore.shared.knownAreas()
        return [.all] + areas.map { AreaEntity(id: $0, name: areaDisplayName($0)) }
    }
}

struct SelectNowAreaIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Tuit Now"
    static let description = IntentDescription("Choose whether to show all of Now or narrow to one area.")

    @Parameter(title: "Area")
    var area: AreaEntity?
}

/// Completes a task directly from an iOS Home Screen widget, sending its revision so
/// concurrent edits are never overwritten silently.
struct CompleteTaskFromWidgetIntent: AppIntent {
    static let title: LocalizedStringResource = "Complete Task"
    static let description = IntentDescription("Mark a Tuit task done from the widget.")
    static let openAppWhenRun = false

    @Parameter(title: "Task ID")
    var taskID: String

    @Parameter(title: "Expected Revision")
    var expectedRevision: Int

    @Parameter(title: "Area")
    var area: String?

    init() {}

    init(taskID: String, expectedRevision: Int, area: String?) {
        self.taskID = taskID
        self.expectedRevision = expectedRevision
        self.area = area
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        guard let credentials = Credentials.stored(),
              let serverString = TuitGroup.savedServerURL ?? (Bundle.main.object(forInfoDictionaryKey: "TuitServer") as? String),
              let base = URL(string: serverString)
        else {
            return .result()
        }

        let api = API(base: base, credentials: credentials, offlineStore: nil)
        do {
            let _: TaskView = try await api.post(
                "/tasks/\(taskID)/complete",
                CompleteBody(expectedRevision: expectedRevision)
            )
            // Refresh both unfiltered Now (when needed) and this widget's area snapshot.
            let query = area.flatMap { $0.isEmpty ? nil : ["area": $0] } ?? [:]
            if let fresh: NowView = try? await api.get("/now", query: query) {
                let existing = WidgetSnapshotStore.shared.load(area: area)
                let snap = WidgetNowSnapshot.from(
                    now: fresh,
                    serverURL: serverString,
                    timezone: existing?.timezone
                )
                WidgetSnapshotStore.shared.save(snap)
            }
            if area != nil, let allNow: NowView = try? await api.get("/now") {
                let existing = WidgetSnapshotStore.shared.load(area: nil)
                let snap = WidgetNowSnapshot.from(
                    now: allNow,
                    serverURL: serverString,
                    timezone: existing?.timezone
                )
                WidgetSnapshotStore.shared.save(snap)
            }
            WidgetCenter.shared.reloadAllTimelines()
        } catch {
            // If a conflict or network failure happened, reload timelines so the widget reflects latest state.
            WidgetCenter.shared.reloadAllTimelines()
        }
        return .result()
    }
}
