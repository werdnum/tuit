import Foundation
import Observation

/// Durable snapshots and an ordered outbox for this sign-in. Never stores credentials.
/// Writes hit disk before the network; a lost response is retried with the same key/revision.
@Observable
final class OfflineStore {
    struct Snapshot: Codable {
        var data: Data
        var savedAt: Date
    }
    struct Pending: Codable, Identifiable {
        var id = UUID().uuidString
        var method: String
        var path: String
        var body: Data
        var savedAt = Date.now
        var problem: String?

        var label: String {
            let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
            return json?["title"] as? String ?? json?["note"] as? String ?? "\(method) \(path)"
        }
    }
    private struct State: Codable {
        var server: String
        var snapshots: [String: Snapshot] = [:]
        var pending: [Pending] = []
    }

    private var state: State
    private let file: URL
    private var active = true
    private var unreadable = false
    private var responses: [String: Data] = [:]
    private static var current: OfflineStore?

    static func open(server: String, identity: String) -> OfflineStore {
        let file = file(for: identity)
        if let current, current.active, current.state.server == server, current.file == file { return current }
        let store = OfflineStore(server: server, file: file)
        current = store
        return store
    }

    func takeResponse(_ id: String) -> Data? { responses.removeValue(forKey: id) }
    private(set) var offline = false
    private(set) var syncing = false
    private(set) var storageError: String?
    var pending: [Pending] { state.pending }
    var lastSaved: Date? { state.snapshots.values.map(\.savedAt).min() }

    init(server: String, file: URL) {
        self.file = file
        state = State(server: server)
        if FileManager.default.fileExists(atPath: file.path) {
            do {
                let saved = try JSONDecoder().decode(State.self, from: Data(contentsOf: file))
                if saved.server == server { state = saved }
                else { try FileManager.default.removeItem(at: file) }
            } catch {
                // Keep the original file for recovery; never overwrite an unreadable outbox.
                unreadable = true
                storageError = "Saved data couldn't be read. Sign out to reset this phone's saved data."
            }
        }
    }

    static func file(for identity: String) -> URL {
        URL.applicationSupportDirectory.appending(path: "Tuit/offline-\(identity).json")
    }

    static func key(_ path: String, _ query: [String: String] = [:]) -> String {
        // Encode components so different queries cannot alias one another.
        let pairs = query.keys.sorted().map { [$0, query[$0]!] }
        let encoded = try! JSONEncoder().encode(pairs)
        return path + "?" + encoded.base64EncodedString()
    }

    func cached(_ path: String, query: [String: String] = [:]) -> Data? {
        guard active else { return nil }
        if let snapshot = state.snapshots[Self.key(path, query)] { return snapshot.data }
        if path == "/tasks", let all = state.snapshots[Self.key("/tasks")],
           let list = try? API.decoder.decode(TaskList.self, from: all.data) {
            let text = query["q"]?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
            let tasks = list.tasks.filter { task in
                let stateMatches = query["state"].map { $0 == "active" ? !task.isClosed : task.state == $0 } ?? true
                let detail = state.snapshots[Self.key("/tasks/" + task.id)].flatMap { try? API.decoder.decode(TaskView.self, from: $0.data) }
                let haystack = [task.title, task.brief, task.nextAction] + (detail?.activity?.map(\.body) ?? [])
                return stateMatches && (text.isEmpty || haystack.contains { $0.lowercased().contains(text) })
            }
            return try? API.encoder.encode(TaskList(tasks: tasks))
        }
        return nil
    }

    func save(_ data: Data, path: String, query: [String: String] = [:]) throws {
        guard active else { throw CancellationError() }
        var next = state
        next.snapshots[Self.key(path, query)] = Snapshot(data: data, savedAt: .now)
        if path == "/tasks", query.isEmpty, let list = try? API.decoder.decode(TaskList.self, from: data) {
            let allowed = Set(list.tasks.map(\.id))
            next.snapshots = next.snapshots.filter { key, snapshot in
                if key.hasPrefix("/tasks/") {
                    guard let view = try? API.decoder.decode(TaskView.self, from: snapshot.data) else { return false }
                    return allowed.contains(view.task.id)
                }
                if key.hasPrefix("/now?") {
                    guard let now = try? API.decoder.decode(NowView.self, from: snapshot.data) else { return false }
                    let ids = (now.plan.map { $0.item.id } + now.urgent.map(\.id) + now.newItems.map(\.id) + now.also.map(\.id))
                    return ids.allSatisfy { allowed.contains($0) }
                }
                // Drop prior filtered/search lists: build them from the fresh full list instead.
                return !key.hasPrefix("/tasks?") || key == Self.key("/tasks")
            }
        }
        try commit(next)
    }

    func enqueue(method: String, path: String, body: Data) throws -> Pending {
        guard active else { throw CancellationError() }
        let item = Pending(method: method, path: path, body: body)
        var next = state
        next.pending.append(item)
        try commit(next)
        return item
    }

    func remove(_ id: String) throws {
        var next = state
        next.pending.removeAll { $0.id == id }
        try commit(next)
    }

    func retry(_ id: String) throws {
        var next = state
        if let i = next.pending.firstIndex(where: { $0.id == id }) { next.pending[i].problem = nil }
        try commit(next)
    }

    func clear() {
        active = false
        state.snapshots = [:]
        state.pending = []
        responses = [:]
        do { if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) } }
        catch { storageError = "Couldn't remove saved data: \(error.localizedDescription)" }
    }

    private func commit(_ next: State) throws {
        guard active else { throw CancellationError() }
        if unreadable { throw APIError.server(storageError ?? "Saved data is unavailable.") }
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(next).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            var url = file
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try url.setResourceValues(values)
            state = next
            storageError = nil
        } catch {
            storageError = "Couldn't save on this phone. \(error.localizedDescription)"
            throw APIError.server(storageError!)
        }
    }

    /// Stops at a rejected change. Later changes never jump ahead or overwrite a conflict.
    func sync(send: (Pending) async throws -> Data) async throws {
        guard active, !syncing else { return }
        syncing = true
        defer { syncing = false }
        while active, let item = state.pending.first, item.problem == nil {
            do {
                let data = try await send(item)
                guard active else { return }
                let view = try API.decoder.decode(TaskView.self, from: data)
                var next = state
                next.pending.removeAll { $0.id == item.id }
                // Later edits made against the same saved revision can follow our own edit.
                // Never remove the check: a remote edit after this response still conflicts.
                let original = (try? JSONSerialization.jsonObject(with: item.body)) as? [String: Any]
                if let revision = original?["expected_revision"] as? Int {
                    let taskPath = "/tasks/" + view.task.id
                    for index in next.pending.indices {
                        let pending = next.pending[index]
                        guard pending.path == taskPath || pending.path.hasPrefix(taskPath + "/"),
                              var json = (try? JSONSerialization.jsonObject(with: pending.body)) as? [String: Any],
                              json["expected_revision"] as? Int == revision else { continue }
                        json["expected_revision"] = view.task.revision
                        next.pending[index].body = try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys])
                    }
                }
                next.snapshots[Self.key("/tasks/" + view.task.id)] = Snapshot(data: data, savedAt: .now)
                try commit(next)
                responses[item.id] = data
                // Responses are only for callers currently waiting; bound background replay memory.
                while responses.count > 100, let old = responses.keys.first(where: { $0 != item.id }) {
                    responses.removeValue(forKey: old)
                }
                offline = false
            } catch APIError.transport {
                offline = true
                return
            } catch APIError.unauthenticated {
                throw APIError.unauthenticated
            } catch is CancellationError {
                return
            } catch {
                guard active else { return }
                var next = state
                if let i = next.pending.firstIndex(where: { $0.id == item.id }) {
                    next.pending[i].problem = error.localizedDescription
                }
                try commit(next)
                return
            }
        }
    }

    func invalidateSnapshots() throws {
        var next = state
        next.snapshots.removeAll()
        try commit(next)
    }

    func setOffline(_ value: Bool) { offline = value }
}
