import Foundation

enum APIError: LocalizedError {
    /// The token was revoked or has expired: the app must sign in again.
    case unauthenticated
    /// Someone else changed the task first (HTTP 409). The caller reloads and shows the message.
    case conflict(String)
    case server(String)
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .unauthenticated: "You've been signed out. Sign in again."
        case .conflict(let m): "Someone changed this first. \(m)"
        case .server(let m): m
        case .transport(let m): m
        }
    }
}

/// A thin client for the REST API. Every rule (urgency, recurrence, visibility) is the
/// server's; this only moves JSON.
struct API: Sendable {
    let base: URL
    let token: String

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
        var comps = URLComponents(url: base.appending(path: "api" + path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { comps.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var req = URLRequest(url: comps.url!)
        req.httpMethod = method
        req.timeoutInterval = 20
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try Self.encoder.encode(body)
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: req)
        } catch {
            throw APIError.transport("Couldn't reach Tuit. \(error.localizedDescription)")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if status == 401 { throw APIError.unauthenticated }
            let message = (try? Self.decoder.decode(APIErrorBody.self, from: data))?.message
                ?? "Tuit said no (HTTP \(status))."
            if status == 409 { throw APIError.conflict(message) }
            throw APIError.server(message)
        }
        do {
            return try Self.decoder.decode(T.self, from: data)
        } catch {
            throw APIError.server("Tuit sent something unexpected: \(error)")
        }
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
    var at: String? = nil
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

    private enum CodingKeys: String, CodingKey {
        case title, brief, nextAction, doneMeans, visibility, area
        case target, deadline, availableFrom, expires, expectedRevision
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
    }
}
