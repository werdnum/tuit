import Foundation

// Wire types for the REST API (`/api`). They mirror src/domain/types.ts and src/domain/views.ts;
// the server does all the interpreting (urgency, labels, recurrence), so these stay dumb.

/// A calendar date in the household zone, or an exact instant. Never interchangeable.
enum Moment: Codable, Hashable {
    case date(String)
    case at(String)

    private enum Keys: String, CodingKey { case date, at }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        if let d = try c.decodeIfPresent(String.self, forKey: .date) {
            self = .date(d)
        } else {
            self = .at(try c.decode(String.self, forKey: .at))
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .date(let d): try c.encode(d, forKey: .date)
        case .at(let a): try c.encode(a, forKey: .at)
        }
    }
}

enum Actor: Codable, Hashable {
    case user(String)
    case agent(String)
    case anyone

    private enum Keys: String, CodingKey { case kind, user, agent }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "user": self = .user(try c.decode(String.self, forKey: .user))
        case "agent": self = .agent(try c.decode(String.self, forKey: .agent))
        default: self = .anyone
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .user(let u):
            try c.encode("user", forKey: .kind)
            try c.encode(u, forKey: .user)
        case .agent(let a):
            try c.encode("agent", forKey: .kind)
            try c.encode(a, forKey: .agent)
        case .anyone:
            try c.encode("anyone", forKey: .kind)
        }
    }

    /// The text form the API accepts as input: a user id, "agent:<name>" or "anyone".
    var input: String {
        switch self {
        case .user(let u): u
        case .agent(let a): "agent:\(a)"
        case .anyone: "anyone"
        }
    }
}

struct Recurrence: Codable, Hashable {
    var mode: String
    var everyDays: Int
}

struct Waiting: Codable, Hashable {
    var kind: String
    var `for`: String
    var taskId: String?
    var since: String
    var followUp: Moment?
}

struct Attachment: Codable, Hashable, Identifiable {
    var id: String
    var url: String
    var title: String
    var mimeType: String
    var addedAt: String
}

struct Author: Codable, Hashable {
    var user: String?
    var agent: String?
}

struct Claim: Codable, Hashable {
    var id: String
    var agent: String
    var user: String?
    var expiresAt: String
    var sideEffects: Bool
}

struct TaskItem: Codable, Hashable, Identifiable {
    var id: String
    var title: String
    var brief: String
    var nextAction: String
    var doneMeans: String
    var owner: String
    var visibility: String
    var nextActor: Actor
    var actorSince: String
    var state: String
    var closeReason: String
    var closedAt: String?
    var waiting: Waiting?
    var availableFrom: Moment?
    var target: Moment?
    var deadline: Moment?
    var expires: Moment?
    var area: String?
    var requires: [String]
    var prefers: [String]
    var recurrence: Recurrence?
    var attachments: [Attachment]
    var lastDoneAt: String?
    var lastSkipAt: String?
    var claim: Claim?
    var revision: Int
    var createdAt: String
    var updatedAt: String
    var createdBy: Author

    var isClosed: Bool { ["done", "expired", "shelved"].contains(state) }
    var isPrivate: Bool { visibility == "private" }
}

struct TaskStatus: Codable, Hashable {
    struct Routine: Codable, Hashable {
        var dueAt: String
        var stale: Bool
        var label: String
    }

    var available: Bool
    var held: String?
    var label: String
    var urgent: String?
    var followUpDue: Bool
    var claimLapsed: Bool
    var routine: Routine?
    var snoozedUntil: String?
    var pinned: Bool
}

struct ActivityEntry: Codable, Hashable, Identifiable {
    var id: Int
    var kind: String
    var body: String
    var happenedAt: String
    var recordedAt: String
    var author: Author
}

/// `{task, status}` from every task mutation, plus `activity` from GET /api/tasks/:id.
struct TaskView: Codable {
    var task: TaskItem
    var status: TaskStatus
    var activity: [ActivityEntry]?
}

struct QueueItem: Codable, Hashable, Identifiable {
    var task: TaskItem
    var why: String
    var label: String
    var urgent: Bool
    var stale: Bool
    var snoozedUntil: String?
    var pinned: Bool

    var id: String { task.id }
}

struct NowView: Codable {
    struct PlanRow: Codable, Hashable, Identifiable {
        var item: QueueItem
        var done: Bool
        var id: String { item.id }
    }

    struct Away: Codable, Hashable {
        var since: String
        var expired: Int
        var handedToYou: Int
        var becameDue: Int
    }

    var date: String
    var area: String?
    var areas: [String]
    var plan: [PlanRow]
    var newItems: [QueueItem]
    var also: [QueueItem]
    var moreCount: Int
    var urgent: [QueueItem]
    var enoughUntil: String?
    var waitingCount: Int
    var restingCount: Int
    var away: Away?
}

struct Me: Codable {
    struct User: Codable, Hashable {
        var id: String
        var name: String
    }

    var user: User?
    var agent: String?
    var canWrite: Bool
    var household: [User]
}

struct TaskList: Codable {
    var tasks: [TaskItem]
}

struct ChangePage: Codable {
    var cursor: String
    var events: [Event]

    struct Event: Codable {
        var seq: Int
    }
}

struct APIErrorBody: Codable {
    var error: String
    var message: String
}
