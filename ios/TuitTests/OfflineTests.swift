import Foundation
import Testing
@testable import Tuit

@Suite(.serialized) @MainActor
struct OfflineTests {
    private func store() -> OfflineStore {
        OfflineStore(server: "https://one.example", file: FileManager.default.temporaryDirectory.appending(path: "\(UUID())/offline.json"))
    }
    private var response: Data { Data(taskJSON.utf8) }
    private func body(_ title: String = "Capture") throws -> Data {
        try API.encoder.encode(CaptureBody(title: title))
    }

    @Test func snapshotsAndOutboxSurviveRelaunch() throws {
        let file = FileManager.default.temporaryDirectory.appending(path: "\(UUID())/offline.json")
        let first = OfflineStore(server: "one", file: file)
        try first.save(response, path: "/tasks/id")
        let pending = try first.enqueue(method: "POST", path: "/tasks", body: body())
        let second = OfflineStore(server: "one", file: file)
        #expect(second.cached("/tasks/id") == response)
        #expect(second.pending.first?.id == pending.id)
        #expect(second.pending.first?.body == pending.body)
        second.clear()
        #expect(!FileManager.default.fileExists(atPath: file.path))
    }

    @Test func serverSwitchAndSignOutCannotReuseData() async throws {
        let file = FileManager.default.temporaryDirectory.appending(path: "\(UUID())/offline.json")
        let first = OfflineStore(server: "one", file: file)
        try first.save(response, path: "/me")
        _ = try first.enqueue(method: "POST", path: "/tasks", body: body())
        let second = OfflineStore(server: "two", file: file)
        #expect(second.cached("/me") == nil)
        #expect(second.pending.isEmpty)
        second.clear()
        await #expect(throws: CancellationError.self) { try second.save(response, path: "/me") }
        #expect(second.cached("/me") == nil)
    }

    @Test func corruptOutboxIsPreservedAndCannotBeOverwritten() throws {
        let file = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        let original = Data("corrupt but potentially recoverable".utf8)
        try original.write(to: file)
        let store = OfflineStore(server: "one", file: file)
        defer { store.clear() }
        #expect(store.storageError != nil)
        #expect(throws: (any Error).self) { try store.enqueue(method: "POST", path: "/tasks", body: body()) }
        #expect(try Data(contentsOf: file) == original)
    }

    @Test func refreshedTaskListRemovesNoLongerVisibleDetails() throws {
        let store = store()
        defer { store.clear() }
        try store.save(response, path: "/tasks/mygvj5ep")
        try store.save(try API.encoder.encode(TaskList(tasks: [])), path: "/tasks")
        #expect(store.cached("/tasks/mygvj5ep") == nil)
    }

    @Test func completionRecordsTapTimeBeforeReconnect() throws {
        let body = CompleteBody(expectedRevision: 3)
        #expect(body.at != nil)
        let at = try #require(body.at.flatMap { ISO8601DateFormatter().date(from: $0) })
        #expect(abs(at.timeIntervalSinceNow) < 2)
    }

    @Test func credentialIdentitySurvivesColdLaunchAndChangesOnNewSignIn() throws {
        defer { Credentials.clear() }
        let first = Credentials.pasted("offline-tests-personal-token")
        let restored = try #require(Credentials.stored())
        #expect(restored.offlineIdentity == first.offlineIdentity)
        let second = Credentials.pasted("another-offline-tests-token")
        #expect(second.offlineIdentity != first.offlineIdentity)
    }

    @Test func queriesAreIsolatedAndCanonical() throws {
        let store = store()
        defer { store.clear() }
        try store.save(response, path: "/now", query: ["area": "home", "other": "x"])
        #expect(store.cached("/now", query: ["other": "x", "area": "home"]) == response)
        #expect(store.cached("/now", query: ["area": "work", "other": "x"]) == nil)
        #expect(OfflineStore.key("/tasks", ["a": "b&c=d"]) != OfflineStore.key("/tasks", ["a": "b", "c": "d"]))
    }

    @Test func offlineSearchAndFiltersUseSavedTasksAndNotes() throws {
        let store = store()
        defer { store.clear() }
        let view = try API.decoder.decode(TaskView.self, from: response)
        try store.save(try API.encoder.encode(TaskList(tasks: [view.task])), path: "/tasks")
        try store.save(response, path: "/tasks/\(view.task.id)")
        let matches = try API.decoder.decode(TaskList.self, from: #require(store.cached("/tasks", query: ["state": "waiting", "q": "NO ANSWER"])))
        #expect(matches.tasks.map(\.id) == [view.task.id])
        let wrongState = try API.decoder.decode(TaskList.self, from: #require(store.cached("/tasks", query: ["state": "done"])))
        #expect(wrongState.tasks.isEmpty)
    }

    @Test func lostResponseKeepsExactBodyAndReplaysOnce() async throws {
        let store = store()
        defer { store.clear() }
        let item = try store.enqueue(method: "POST", path: "/tasks", body: body())
        await storeSyncTransport(store)
        #expect(store.offline)
        #expect(store.pending.first?.body == item.body)
        var sent: [Data] = []
        try await store.sync { request in sent.append(request.body); return response }
        try await store.sync { _ in Issue.record("Already acknowledged"); return response }
        #expect(sent == [item.body])
        #expect(store.pending.isEmpty)
        #expect(!store.offline)
        #expect(store.cached("/tasks/mygvj5ep") == response)
    }

    private func storeSyncTransport(_ store: OfflineStore) async {
        try? await store.sync { _ in throw APIError.transport("Lost response") }
    }

    @Test func concurrentSyncDoesNotDuplicateDelivery() async throws {
        let store = store()
        defer { store.clear() }
        _ = try store.enqueue(method: "POST", path: "/tasks", body: body())
        var sent = 0
        try await store.sync { _ in
            sent += 1
            try await store.sync { _ in Issue.record("Reentrant sync sent twice"); return response }
            return response
        }
        #expect(sent == 1)
    }

    @Test func conflictBlocksLaterChangesAndSurvivesRelaunch() async throws {
        let store = store()
        defer { store.clear() }
        let first = try store.enqueue(method: "PATCH", path: "/tasks/id", body: body("first"))
        _ = try store.enqueue(method: "POST", path: "/tasks", body: body("second"))
        var sent = 0
        try await store.sync { _ in sent += 1; throw APIError.conflict("Revision changed") }
        try await store.sync { _ in Issue.record("Conflict was retried automatically"); return response }
        #expect(sent == 1)
        #expect(store.pending.count == 2)
        #expect(store.pending.first?.problem?.contains("Revision changed") == true)
        try store.remove(first.id)
        try await store.sync { _ in return response }
        #expect(store.pending.isEmpty)
    }

    @Test func invalidResponseIsNotAcknowledged() async throws {
        let store = store()
        defer { store.clear() }
        _ = try store.enqueue(method: "POST", path: "/tasks", body: body())
        try await store.sync { _ in Data("garbled".utf8) }
        #expect(store.pending.count == 1)
        #expect(store.pending.first?.problem != nil)
    }

    @Test func revokedCredentialsDoNotReplayOrDiscardPending() async throws {
        let store = store()
        defer { store.clear() }
        _ = try store.enqueue(method: "POST", path: "/tasks", body: body())
        do {
            try await store.sync { _ in throw APIError.unauthenticated }
            Issue.record("Must propagate authentication failure")
        } catch APIError.unauthenticated { }
        #expect(store.pending.count == 1)
        #expect(store.pending.first?.problem == nil)
    }

    @Test func signOutDuringDeliveryCannotRestoreSnapshots() async throws {
        let store = store()
        _ = try store.enqueue(method: "POST", path: "/tasks", body: body())
        try await store.sync { _ in store.clear(); return response }
        #expect(store.pending.isEmpty)
        #expect(store.cached("/tasks/mygvj5ep") == nil)
    }

    @Test func diskFailureCannotReportSaved() throws {
        let file = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try Data().write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let store = OfflineStore(server: "one", file: file.appending(path: "offline.json"))
        #expect(throws: (any Error).self) { try store.enqueue(method: "POST", path: "/tasks", body: body()) }
        #expect(store.pending.isEmpty)
        #expect(store.storageError != nil)
    }

    @Test func revisionAndKeyArePreservedForQueuedEdits() throws {
        let body = EditBody(title: "offline edit", expectedRevision: 42)
        let data = try API.encoder.encode(body)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        #expect(json["expected_revision"] as? Int == 42)
        #expect(json["idempotency_key"] as? String == body.idempotencyKey)
        #expect(API.canQueue("PATCH", "/tasks/id", data))
        #expect(!API.canQueue("POST", "/now/more", data))
        #expect(!API.canQueue("POST", "/tasks/id/snooze", try API.encoder.encode(SnoozeBody(until: "tomorrow"))))
    }
}

nonisolated private final class OfflineProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var reply: (@Sendable (URLRequest) throws -> (Int, Data))?
    nonisolated override class func canInit(with request: URLRequest) -> Bool { true }
    nonisolated override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    nonisolated override func startLoading() {
        do {
            let (status, data) = try Self.reply!(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    nonisolated override func stopLoading() { }
}

@Suite(.serialized) @MainActor
struct OfflineAPITests {
    private func setup() -> (API, OfflineStore) {
        let store = OfflineStore(server: "https://offline.example", file: FileManager.default.temporaryDirectory.appending(path: "\(UUID())/offline.json"))
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [OfflineProtocol.self]
        return (API(base: URL(string: "https://offline.example")!, credentials: .debug("test"), offlineStore: store, urlSession: URLSession(configuration: config)), store)
    }

    @Test func onlineReadThenOfflineUsesSavedData() async throws {
        let (api, store) = setup()
        defer { store.clear(); OfflineProtocol.reply = nil }
        let data = Data(taskJSON.utf8)
        OfflineProtocol.reply = { _ in (200, data) }
        let online: TaskView = try await api.get("/tasks/id")
        OfflineProtocol.reply = { _ in throw URLError(.notConnectedToInternet) }
        let offline: TaskView = try await api.get("/tasks/id")
        #expect(offline.task.id == online.task.id)
        #expect(store.offline)
    }

    @Test func serverRejectionCannotFallBackToPrivateSnapshot() async throws {
        let (api, store) = setup()
        defer { store.clear(); OfflineProtocol.reply = nil }
        try store.save(Data(taskJSON.utf8), path: "/tasks/id")
        OfflineProtocol.reply = { _ in (403, Data(#"{"error":"forbidden","message":"Private"}"#.utf8)) }
        do {
            let _: TaskView = try await api.get("/tasks/id")
            Issue.record("Returned cached unauthorized task")
        } catch APIError.server { }
        #expect(!store.offline)
        #expect(store.cached("/tasks/id") == nil)
    }

    @Test func captureIsDurableAndReconnectReplaysSameKey() async throws {
        let (api, store) = setup()
        defer { store.clear(); OfflineProtocol.reply = nil }
        let capture = CaptureBody(title: "offline capture")
        OfflineProtocol.reply = { _ in throw URLError(.networkConnectionLost) }
        do {
            let _: TaskView = try await api.post("/tasks", capture)
            Issue.record("Reported remote success offline")
        } catch APIError.queued { }
        #expect(store.pending.count == 1)
        let saved = try JSONSerialization.jsonObject(with: #require(store.pending.first?.body)) as! [String: Any]
        #expect(saved["idempotency_key"] as? String == capture.idempotencyKey)
        let data = Data(taskJSON.utf8)
        OfflineProtocol.reply = { request in
            #expect(request.httpMethod == "POST")
            return (201, data)
        }
        try await api.sync()
        #expect(store.pending.isEmpty)
    }

    @Test func onlineCaptureReturnsAuthoritativeResponse() async throws {
        let (api, store) = setup()
        defer { store.clear(); OfflineProtocol.reply = nil }
        let data = Data(taskJSON.utf8)
        OfflineProtocol.reply = { _ in (201, data) }
        let captured: TaskView = try await api.post("/tasks", CaptureBody(title: "online"))
        #expect(captured.task.id == "mygvj5ep")
        #expect(store.pending.isEmpty)
    }

    @Test func missingViewDoesNotInventAResult() async throws {
        let (api, store) = setup()
        defer { store.clear(); OfflineProtocol.reply = nil }
        OfflineProtocol.reply = { _ in throw URLError(.notConnectedToInternet) }
        do {
            let _: TaskView = try await api.get("/tasks/never-seen")
            Issue.record("Invented offline result")
        } catch APIError.transport(let message) { #expect(message.contains("saved")) }
    }
}
