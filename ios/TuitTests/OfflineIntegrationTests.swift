import Foundation
import Testing
@testable import Tuit

/// Run with `npm run test:ios:offline`: real PostgreSQL and REST, with a fault-injecting proxy.
@Suite(.serialized) @MainActor
struct OfflineIntegrationTests {
    struct Config: Decodable { var base: String; var token: String; var taskID: String }
    private func config() async throws -> Config? {
        // Ordinary Xcode runs need no server; the dedicated runner makes these tests required.
        guard let (data, _) = try? await URLSession.shared.data(from: URL(string: "http://localhost:18089/config")!) else { return nil }
        return try JSONDecoder().decode(Config.self, from: data)
    }
    private func mode(_ value: String) async throws {
        _ = try await URLSession.shared.data(from: URL(string: "http://localhost:18089/mode/" + value)!)
    }

    @Test func lostCaptureResponseRelaunchAndReconnectCreateExactlyOneTask() async throws {
        guard let config = try await config() else { return }
        try await mode("online")
        let file = FileManager.default.temporaryDirectory.appending(path: "\(UUID())/offline.json")
        let store = OfflineStore(server: config.base, file: file)
        let api = API(base: URL(string: config.base)!, credentials: .debug(config.token), offlineStore: store)
        let title = "Capture after lost response \(UUID())"
        try await mode("lose-write")
        do {
            let _: TaskView = try await api.post("/tasks", CaptureBody(title: title))
            Issue.record("Lost response must be pending")
        } catch APIError.queued { }
        #expect(store.pending.count == 1)
        let relaunched = OfflineStore(server: config.base, file: file)
        let restored = API(base: api.base, credentials: .debug(config.token), offlineStore: relaunched)
        try await mode("online")
        try await restored.sync()
        #expect(relaunched.pending.isEmpty)
        let list: TaskList = try await restored.get("/tasks")
        #expect(list.tasks.filter { $0.title == title }.count == 1)
        relaunched.clear()
    }

    @Test func savedReadsAndCompletionRecoverWithoutLosingHistory() async throws {
        guard let config = try await config() else { return }
        try await mode("online")
        let store = OfflineStore(server: config.base, file: FileManager.default.temporaryDirectory.appending(path: "\(UUID())/offline.json"))
        defer { store.clear() }
        let api = API(base: URL(string: config.base)!, credentials: .debug(config.token), offlineStore: store)
        let created: TaskView = try await api.post("/tasks", CaptureBody(title: "Offline completion \(UUID())"))
        let saved: TaskView = try await api.get("/tasks/\(created.task.id)")
        try await mode("offline")
        let cached: TaskView = try await api.get("/tasks/\(created.task.id)")
        #expect(cached.activity?.count == saved.activity?.count)
        do {
            let _: TaskView = try await api.post("/tasks/\(created.task.id)/complete", CompleteBody(expectedRevision: saved.task.revision))
        } catch APIError.queued { }
        #expect(store.pending.count == 1)
        try await mode("online")
        try await api.sync()
        let done: TaskView = try await api.get("/tasks/\(created.task.id)")
        #expect(done.task.state == "done")
        #expect(done.task.revision == saved.task.revision + 1)
        #expect((done.activity?.count ?? 0) > (saved.activity?.count ?? 0))
    }

    @Test func expiredAccessTokenStillAllowsSavedReadsWithoutSigningOutOffline() async throws {
        guard let config = try await config() else { return }
        let store = OfflineStore(server: config.base, file: FileManager.default.temporaryDirectory.appending(path: "\(UUID())/offline.json"))
        defer { store.clear(); Credentials.clear() }
        let provider = IdentityProvider(authorizationEndpoint: URL(string: config.base + "/authorize")!, tokenEndpoint: URL(string: config.base + "/token")!)
        let credentials = try #require(Credentials.signedIn(provider, TokenGrant(accessToken: "expired-fixture", refreshToken: "fixture-refresh", expiresIn: -1)))
        try store.save(Data(taskJSON.utf8), path: "/tasks/saved")
        try await mode("offline")
        let api = API(base: URL(string: config.base)!, credentials: credentials, offlineStore: store)
        let cached: TaskView = try await api.get("/tasks/saved")
        #expect(cached.task.id == "mygvj5ep")
        #expect(store.offline)
        #expect(Credentials.stored()?.offlineIdentity == credentials.offlineIdentity)
        try await mode("online")
    }

    @Test func concurrentServerEditBlocksOfflineEditWithoutOverwriting() async throws {
        guard let config = try await config() else { return }
        try await mode("online")
        let store = OfflineStore(server: config.base, file: FileManager.default.temporaryDirectory.appending(path: "\(UUID())/offline.json"))
        defer { store.clear() }
        let api = API(base: URL(string: config.base)!, credentials: .debug(config.token), offlineStore: store)
        let remote = API(base: api.base, credentials: .debug(config.token))
        let created: TaskView = try await api.post("/tasks", CaptureBody(title: "Conflict fixture"))
        try await mode("offline")
        do {
            let _: TaskView = try await api.patch("/tasks/\(created.task.id)", EditBody(title: "Offline edit", expectedRevision: created.task.revision))
        } catch APIError.queued { }
        try await mode("online")
        let _: TaskView = try await remote.patch("/tasks/\(created.task.id)", EditBody(title: "Someone else's edit", expectedRevision: created.task.revision))
        try await api.sync()
        #expect(store.pending.first?.problem?.contains("Someone changed") == true)
        let current: TaskView = try await remote.get("/tasks/\(created.task.id)")
        #expect(current.task.title == "Someone else's edit")
    }
}
