import Foundation
import Testing
@testable import Tuit

// Responses captured from a real server (npm run local), so a wire change shows up here.
private let nowJSON = #"""
{"date":"2026-09-30","area":null,"areas":["home","tuit"],"plan":[{"item":{"task":{"id":"rwznkqt5","seq":2,"title":"water plants","brief":"","next_action":"","done_means":"","owner":"alex","visibility":"household","next_actor":{"kind":"user","user":"alex"},"actor_since":"2026-09-29T23:01:39.194Z","state":"open","close_reason":"","closed_at":null,"waiting":null,"available_from":null,"available_rule":null,"target":null,"target_rule":null,"deadline":null,"expires":null,"area":null,"requires":[],"prefers":[],"recurrence":{"mode":"since_done","every_days":3},"attachments":[],"last_done_at":"2026-09-29T23:01:49.626Z","last_skip_at":null,"claim":null,"revision":2,"created_at":"2026-09-29T23:01:39.194Z","updated_at":"2026-09-29T23:01:49.626Z","created_by":{"user":"alex","agent":null}},"why":"last done just now","label":"last done just now","urgent":false,"stale":false,"snoozed_until":null,"pinned":false},"done":true}],"new_items":[],"also":[],"more_count":0,"urgent":[{"task":{"id":"mygvj5ep","seq":1,"title":"ring the vet about Milo","brief":"**Milo** needs a dental.\n\n- call before 5","next_action":"","done_means":"","owner":"alex","visibility":"household","next_actor":{"kind":"user","user":"alex"},"actor_since":"2026-09-29T23:01:39.147Z","state":"waiting","close_reason":"","closed_at":null,"waiting":{"kind":"reply","for":"vet","task_id":null,"since":"2026-09-29T23:01:39.253Z","follow_up":{"date":"2026-10-01"}},"available_from":null,"available_rule":null,"target":null,"target_rule":null,"deadline":{"date":"2026-10-01"},"expires":null,"area":"home","requires":[],"prefers":[],"recurrence":null,"attachments":[],"last_done_at":null,"last_skip_at":null,"claim":null,"revision":2,"created_at":"2026-09-29T23:01:39.147Z","updated_at":"2026-09-29T23:01:39.253Z","created_by":{"user":"alex","agent":null}},"why":"deadline tomorrow","label":"deadline tomorrow","urgent":true,"stale":false,"snoozed_until":null,"pinned":false}],"enough_until":null,"waiting_count":1,"resting_count":0,"away":null}
"""#

let taskJSON = #"""
{"task":{"id":"mygvj5ep","seq":1,"title":"ring the vet about Milo","brief":"**Milo** needs a dental.\n\n- call before 5","next_action":"","done_means":"","owner":"alex","visibility":"household","next_actor":{"kind":"user","user":"alex"},"actor_since":"2026-09-29T23:01:39.147Z","state":"waiting","close_reason":"","closed_at":null,"waiting":{"kind":"reply","for":"vet","task_id":null,"since":"2026-09-29T23:01:39.253Z","follow_up":{"date":"2026-10-01"}},"available_from":null,"available_rule":null,"target":null,"target_rule":null,"deadline":{"date":"2026-10-01"},"expires":null,"area":"home","requires":[],"prefers":[],"recurrence":null,"attachments":[],"last_done_at":null,"last_skip_at":null,"claim":null,"revision":2,"created_at":"2026-09-29T23:01:39.147Z","updated_at":"2026-09-29T23:01:39.253Z","created_by":{"user":"alex","agent":null}},"status":{"available":false,"held":"waiting","label":"deadline tomorrow","urgent":"deadline tomorrow","follow_up_due":false,"claim_lapsed":false,"routine":null,"snoozed_until":null,"pinned":false},"activity":[{"id":1,"task_id":"mygvj5ep","kind":"created","body":"","data":{},"happened_at":"2026-09-29T23:01:39.147Z","recorded_at":"2026-09-29T23:01:39.147Z","author":{"user":"alex","agent":null}},{"id":4,"task_id":"mygvj5ep","kind":"note","body":"Called, no answer","data":{"state":{"to":"waiting","from":"open"},"waiting":{"for":"vet","kind":"reply","since":"2026-09-29T23:01:39.253Z","task_id":null,"follow_up":{"date":"2026-10-01"}}},"happened_at":"2026-09-29T23:01:39.253Z","recorded_at":"2026-09-29T23:01:39.253Z","author":{"user":"alex","agent":null}}]}
"""#

@Test func decodesNow() throws {
    let now = try API.decoder.decode(NowView.self, from: Data(nowJSON.utf8))
    #expect(now.areas == ["home", "tuit"])
    #expect(now.urgent.first?.task.deadline == .date("2026-10-01"))
    #expect(now.urgent.first?.task.waiting?.for == "vet")
    #expect(now.plan.first?.item.task.recurrence?.everyDays == 3)
}

@Test func decodesTaskWithActivity() throws {
    let view = try API.decoder.decode(TaskView.self, from: Data(taskJSON.utf8))
    #expect(view.task.nextActor == .user("alex"))
    #expect(view.status.urgent == "deadline tomorrow")
    #expect(view.activity?.map(\.kind).contains("note") == true)
}

@Test func editSendsOnlyChangesAndNullsClearedDates() throws {
    let body = EditBody(title: "New", deadline: "", expectedRevision: 3)
    let json = try JSONSerialization.jsonObject(with: API.encoder.encode(body)) as! [String: Any]
    #expect(json["title"] as? String == "New")
    #expect(json["deadline"] is NSNull)
    #expect(json["expected_revision"] as? Int == 3)
    #expect(json["brief"] == nil)
    #expect(json["target"] == nil)
}

@Test func snoozeSendsNullToUnsnooze() throws {
    let json = String(decoding: try API.encoder.encode(SnoozeBody(until: nil)), as: UTF8.self)
    #expect(json == #"{"until":null}"#)
}

@Test func checkpointUsesSnakeCaseKeys() throws {
    let body = CheckpointBody(note: "hi", nextAction: "call", waiting: WaitingBody(kind: "reply", for: "vet", followUp: "fri"))
    let json = try JSONSerialization.jsonObject(with: API.encoder.encode(body)) as! [String: Any]
    #expect(json["next_action"] as? String == "call")
    #expect((json["waiting"] as? [String: Any])?["follow_up"] as? String == "fri")
    #expect(json["idempotency_key"] is String)
}

@Test func captureKeepsItsOwnAreaTagOnly() {
    #expect(namesArea("#tuit fix the feed"))
    #expect(namesArea("fix the feed #Tuit"))
    #expect(!namesArea("Ask about #3"))
    #expect(!namesArea("ask about #3 today"))
    #expect(!namesArea("fix #tuit feed"))
    #expect(!namesArea("#none thing"))
    #expect(!namesArea("#tuit"))
}

@Test func calendarDatesUseTheHouseholdZone() throws {
    let saved = Household.zone
    defer { Household.zone = saved }
    let instant = try #require(ISO8601DateFormatter().date(from: "2026-10-02T20:00:00Z"))
    Household.zone = TimeZone(identifier: "Australia/Sydney")!
    #expect(Fmt.day(instant) == "2026-10-03")
    Household.zone = TimeZone(identifier: "America/Los_Angeles")!
    #expect(Fmt.day(instant) == "2026-10-02")
}

@Test func sharingUsesTheSignedInServerAndWebRoute() {
    #expect(TaskSharing.url(server: "https://tuit.example.com/", taskID: "mygvj5ep")?.absoluteString
            == "https://tuit.example.com/tasks/mygvj5ep")
    #expect(TaskSharing.url(server: "http://localhost:8080/tuit/", taskID: "mygvj5ep")?.absoluteString
            == "http://localhost:8080/tuit/tasks/mygvj5ep")
}

@Test func sharingOmitsServerCredentialsAndQuery() {
    #expect(TaskSharing.url(server: "https://user:secret@tuit.example.com/?token=secret#now", taskID: "mygvj5ep")?.absoluteString
            == "https://tuit.example.com/tasks/mygvj5ep")
    #expect(TaskSharing.url(server: "tuit://tasks", taskID: "mygvj5ep") == nil)
    #expect(TaskSharing.url(server: "", taskID: "mygvj5ep") == nil)
}

@Test func meListsAgentsAndToleratesOlderServers() throws {
    let current = #"{"user":{"id":"alex","name":"Alex"},"agent":null,"can_write":true,"household":[{"id":"alex","name":"Alex"}],"agents":["family-assistant","setup"],"timezone":"Australia/Sydney"}"#
    #expect(try API.decoder.decode(Me.self, from: Data(current.utf8)).agents == ["family-assistant", "setup"])
    let older = #"{"user":{"id":"alex","name":"Alex"},"agent":null,"can_write":true,"household":[{"id":"alex","name":"Alex"}]}"#
    #expect(try API.decoder.decode(Me.self, from: Data(older.utf8)).agents == nil)
}

@Test func decodesNowAreaOtherCountAndToleratesOlderServers() throws {
    let older = try API.decoder.decode(NowView.self, from: Data(nowJSON.utf8))
    #expect(older.areaOtherCount == nil)
    #expect(older.otherCountInArea == 0)

    let narrowed = #"""
    {"date":"2026-09-30","area":"cluster","area_hidden":true,"area_other_count":3,"areas":["cluster","home"],"plan":[],"new_items":[],"also":[],"more_count":0,"urgent":[],"enough_until":null,"waiting_count":0,"resting_count":0,"away":null}
    """#
    let now = try API.decoder.decode(NowView.self, from: Data(narrowed.utf8))
    #expect(now.area == "cluster")
    #expect(now.areaHidden == true)
    #expect(now.otherCountInArea == 3)
}

@Test func decodesBrowseViewWithActiveAndClosedItems() throws {
    let view = try API.decoder.decode(TaskView.self, from: Data(taskJSON.utf8))
    var done = view.task
    done.id = "done1234"
    done.state = "done"
    done.closedAt = "2026-09-30T01:00:00Z"
    let payload = BrowseView(
        state: "all",
        area: "home",
        q: "vet",
        items: [
            BrowseItem(task: view.task, status: view.status),
            BrowseItem(task: done, status: nil),
        ],
        total: 5,
        moreCount: 3,
        areas: ["home", "security"],
        hasNoArea: true
    )
    let encoded = try API.encoder.encode(payload)
    let decoded = try API.decoder.decode(BrowseView.self, from: encoded)
    #expect(decoded.state == "all")
    #expect(decoded.area == "home")
    #expect(decoded.total == 5)
    #expect(decoded.moreCount == 3)
    #expect(decoded.areas == ["home", "security"])
    #expect(decoded.hasNoArea == true)
    #expect(decoded.items.count == 2)
    #expect(decoded.items[0].status?.urgent == "deadline tomorrow")
    #expect(decoded.items[1].status == nil)
}

@Test func taskListFiltersByStateAndAreaIncludingNone() throws {
    let base = try API.decoder.decode(TaskView.self, from: Data(taskJSON.utf8)).task
    var openHome = base
    openHome.id = "open-home"
    openHome.state = "open"
    openHome.area = "home"
    var doneSec = base
    doneSec.id = "done-sec"
    doneSec.state = "done"
    doneSec.area = "security"
    var untagged = base
    untagged.id = "untagged"
    untagged.state = "open"
    untagged.area = nil

    let list = TaskList(tasks: [base, openHome, doneSec, untagged])
    #expect(list.inState("active").map(\.id) == [base.id, "open-home", "untagged"])
    #expect(list.inState("closed").map(\.id) == ["done-sec"])
    #expect(list.inState("all").count == 4)
    #expect(list.matching(state: "open", area: "#Home").map(\.id) == ["open-home"])
    #expect(list.matching(state: "active", area: "none").map(\.id) == ["untagged"])
    #expect(list.matching(state: "closed", area: "security").map(\.id) == ["done-sec"])
}

@Test @MainActor func appNavigationBrowseTasksResetsFilterAndSwitchesTab() {
    let nav = AppNavigation()
    nav.tasksPath = ["old-task"]
    nav.tasksExplicitState = .closed
    nav.tasksQuery = "old search"
    let beforeTick = nav.tasksBrowseTick

    nav.browseTasks(area: "#Security")

    #expect(nav.tab == "tasks")
    #expect(nav.tasksArea == "security")
    #expect(nav.tasksExplicitState == nil)
    #expect(nav.tasksQuery.isEmpty)
    #expect(nav.tasksPath.isEmpty)
    #expect(nav.tasksBrowseTick == beforeTick + 1)
}

@Test func markdownParserHandlesBlocksListsCodeTablesAndDetails() {
    let md = """
    **Status:** Backup failing.

    ## Options
    - [x] Verify data is intact
    - [ ] Silence `KubeJobFailed` for `daily-backup`
      - Nested detail
    1. First step
    2. Second step

    > Lock contention on `locks/*.lck`

    ```
    backupstore/volumes/.../locks/*.lck
    longhorn_backup_*
    ```

    | Option | Risk |
    | --- | --- |
    | Alert on age | Low |

    ---

    <details>
    <summary>Raw errors</summary>

    - Timeout waiting for backup

    </details>
    """

    let blocks = MarkdownParser.parse(md)
    #expect(blocks == [
        .paragraph("**Status:** Backup failing."),
        .heading(level: 2, text: "Options"),
        .list([
            MarkdownListItem(indent: 0, marker: .task(done: true), text: "Verify data is intact"),
            MarkdownListItem(indent: 0, marker: .task(done: false), text: "Silence `KubeJobFailed` for `daily-backup`"),
            MarkdownListItem(indent: 1, marker: .bullet, text: "Nested detail"),
            MarkdownListItem(indent: 0, marker: .ordered("1."), text: "First step"),
            MarkdownListItem(indent: 0, marker: .ordered("2."), text: "Second step"),
        ]),
        .blockquote("Lock contention on `locks/*.lck`"),
        .codeBlock("backupstore/volumes/.../locks/*.lck\nlonghorn_backup_*"),
        .table(headers: ["Option", "Risk"], rows: [["Alert on age", "Low"]]),
        .divider,
        .details(summary: "Raw errors", body: [
            .list([MarkdownListItem(indent: 0, marker: .bullet, text: "Timeout waiting for backup")]),
        ]),
    ])
}
