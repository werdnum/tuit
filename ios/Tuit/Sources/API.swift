import Foundation

enum APIError: LocalizedError {
    /// The token was revoked or has expired: the app must sign in again.
    case unauthenticated
    case queued
    /// Someone else changed the task first (HTTP 409). The caller reloads and shows the message.
    case conflict(String)
    case server(String)
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .queued: "Saved on this phone. Waiting to sync."
        case .unauthenticated: "You've been signed out. Sign in again."
        case .conflict(let m): "Someone changed this first. \(m)"
        case .server(let m): m
        case .transport(let m): m
        }
    }
}

/// A thin client for the REST API. Every rule (urgency, recurrence, visibility) is the
/// server's; this only moves JSON.
struct API {
    let base: URL
    let credentials: Credentials
    var offlineStore: OfflineStore? = nil
    var urlSession: URLSession = .shared

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.keyEncodingStrategy = .convertToSnakeCase
        return e
    }()

    func get<T: Decodable>(_ path: String, query: [String: String] = [:]) async throws -> T {
        try await send("GET", path, query: query, body: nil as [String: String]?)
    }

    func post<T: Decodable, B: Encodable>(_ path: String, _ body: B) async throws -> T {
        try await send("POST", path, body: body)
    }

    func patch<T: Decodable, B: Encodable>(_ path: String, _ body: B) async throws -> T {
        try await send("PATCH", path, body: body)
    }

    func delete<T: Decodable, B: Encodable>(_ path: String, _ body: B) async throws -> T {
        try await send("DELETE", path, body: body)
    }

    private func send<T: Decodable, B: Encodable>(
        _ method: String, _ path: String, query: [String: String] = [:], body: B?
    ) async throws -> T {
        let encoded = try body.map { try Self.encoder.encode($0) }
        if method != "GET", let store = offlineStore, let encoded,
           Self.canQueue(method, path, encoded) {
            let item = try store.enqueue(method: method, path: path, body: encoded)
            if !store.offline { try await sync() }
            if let pending = store.pending.first(where: { $0.id == item.id }) {
                if let problem = pending.problem { throw APIError.server(problem) }
                throw APIError.queued
            }
            guard let result = store.takeResponse(item.id) else { throw CancellationError() }
            return try Self.decoder.decode(T.self, from: result)
        }
        if method == "GET", path != "/changes", offlineStore?.offline == true {
            guard let data = offlineStore?.cached(path, query: query) else {
                throw APIError.transport("This view hasn't been saved on this phone yet. Connect to load it.")
            }
            return try Self.decoder.decode(T.self, from: data)
        }
        do {
            let data = try await request(method, path, query: query, body: encoded)
            let value = try Self.decoder.decode(T.self, from: data)
            if method == "GET", path != "/changes" { try? offlineStore?.save(data, path: path, query: query) }
            offlineStore?.setOffline(false)
            return value
        } catch APIError.transport(let message) {
            offlineStore?.setOffline(true)
            if method != "GET" { throw APIError.transport(message) }
            if method == "GET", let data = offlineStore?.cached(path, query: query) {
                return try Self.decoder.decode(T.self, from: data)
            }
            throw APIError.transport("No connection, and this view hasn't been saved on this phone yet.")
        }
    }

    static func canQueue(_ method: String, _ path: String, _ body: Data) -> Bool {
        guard path == "/tasks" || path.hasPrefix("/tasks/"),
              let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else { return false }
        return json["idempotency_key"] is String
    }

    func sync() async throws {
        guard let store = offlineStore else { return }
        try await store.sync { item in
            try await request(item.method, item.path, body: item.body)
        }
    }

    private func request(_ method: String, _ path: String, query: [String: String] = [:], body: Data?) async throws -> Data {
        do {
            return try await attempt(method, path, query: query, body: body, token: credentials.accessToken())
        } catch APIError.unauthenticated where credentials.canRefresh {
            let fresh = try await credentials.accessToken(forceRefresh: true)
            return try await attempt(method, path, query: query, body: body, token: fresh)
        }
    }

    private func attempt(
        _ method: String, _ path: String, query: [String: String], body: Data?, token: String
    ) async throws -> Data {
        var comps = URLComponents(url: base.appending(path: "api" + path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { comps.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var req = URLRequest(url: comps.url!)
        req.httpMethod = method
        req.timeoutInterval = 20
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await urlSession.data(for: req)
        } catch {
            if Task.isCancelled || (error as? URLError)?.code == .cancelled { throw CancellationError() }
            throw APIError.transport("Couldn't reach Tuit. \(error.localizedDescription)")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if status == 401 { throw APIError.unauthenticated }
            if status == 403 || status == 404 { try offlineStore?.invalidateSnapshots() }
            let message = (try? Self.decoder.decode(APIErrorBody.self, from: data))?.message
                ?? "Tuit said no (HTTP \(status))."
            if status == 409 { throw APIError.conflict(message) }
            throw APIError.server(message)
        }
        return data
    }
}

/// Request bodies. Optional fields left nil are omitted, so the server leaves them alone.
struct CaptureBody: Encodable {
    var title: String
    var idempotencyKey = UUID().uuidString
}

struct CheckpointBody: Encodable {
    var note: String
    var kind: String? = nil
    var brief: String? = nil
    var nextAction: String? = nil
    var nextActor: String? = nil
    var state: String? = nil
    var waiting: WaitingBody? = nil
    var expectedRevision: Int? = nil
    var idempotencyKey = UUID().uuidString
}

struct WaitingBody: Encodable {
    var kind: String
    var `for`: String? = nil
    var followUp: String? = nil
}

struct HandoffBody: Encodable {
    var to: String
    var note: String? = nil
    var nextAction: String? = nil
    var expectedRevision: Int? = nil
    var idempotencyKey = UUID().uuidString
}

struct CompleteBody: Encodable {
    // Keep when you did it, even if delivery waits until after a flight.
    var at: String? = ISO8601DateFormatter().string(from: .now)
    var note: String? = nil
    var expectedRevision: Int? = nil
    var idempotencyKey = UUID().uuidString
}

struct CloseBody: Encodable {
    var state: String
    var reason: String? = nil
    var expectedRevision: Int? = nil
    var idempotencyKey = UUID().uuidString
}

struct RevisionBody: Encodable {
    var expectedRevision: Int? = nil
    var idempotencyKey = UUID().uuidString
}

struct SnoozeBody: Encodable {
    var until: String?

    // `until: null` un-snoozes, so it must be sent rather than omitted.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(until, forKey: .until)
    }

    private enum CodingKeys: String, CodingKey { case until }
}

struct PinBody: Encodable {
    var pinned: Bool
}

struct EnoughBody: Encodable {
    var on: Bool
}

struct AttachBody: Encodable {
    var url: String
    var title: String? = nil
    var expectedRevision: Int? = nil
    var idempotencyKey = UUID().uuidString
}

struct Empty: Encodable {}

/// A PATCH that sends only what changed. Moments go as text the server parses ("fri",
/// "2026-10-03"); an empty string clears the field, sent as null.
struct EditBody: Encodable {
    var title: String?
    var brief: String?
    var nextAction: String?
    var doneMeans: String?
    var visibility: String?
    var area: String?
    var target: String?
    var deadline: String?
    var availableFrom: String?
    var expires: String?
    var expectedRevision: Int?
    var idempotencyKey = UUID().uuidString

    private enum CodingKeys: String, CodingKey {
        case title, brief, nextAction, doneMeans, visibility, area
        case target, deadline, availableFrom, expires, expectedRevision, idempotencyKey
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(brief, forKey: .brief)
        try c.encodeIfPresent(nextAction, forKey: .nextAction)
        try c.encodeIfPresent(doneMeans, forKey: .doneMeans)
        try c.encodeIfPresent(visibility, forKey: .visibility)
        try c.encodeIfPresent(area, forKey: .area)
        for (key, value) in [
            (CodingKeys.target, target), (.deadline, deadline),
            (.availableFrom, availableFrom), (.expires, expires),
        ] {
            guard let value else { continue }
            if value.isEmpty { try c.encodeNil(forKey: key) } else { try c.encode(value, forKey: key) }
        }
        try c.encodeIfPresent(expectedRevision, forKey: .expectedRevision)
        try c.encode(idempotencyKey, forKey: .idempotencyKey)
    }
}
