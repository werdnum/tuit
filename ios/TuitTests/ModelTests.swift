import Foundation
import Testing
@testable import Tuit

// Responses captured from a real server (npm run local), so a wire change shows up here.
private let nowJSON = #"""
{"date":"2026-09-30","area":null,"areas":["home","tuit"],"plan":[{"item":{"task":{"id":"rwznkqt5","seq":2,"title":"water plants","brief":"","next_action":"","done_means":"","owner":"alex","visibility":"household","next_actor":{"kind":"user","user":"alex"},"actor_since":"2026-09-29T23:01:39.194Z","state":"open","close_reason":"","closed_at":null,"waiting":null,"available_from":null,"available_rule":null,"target":null,"target_rule":null,"deadline":null,"expires":null,"area":null,"requires":[],"prefers":[],"recurrence":{"mode":"since_done","every_days":3},"attachments":[],"last_done_at":"2026-09-29T23:01:49.626Z","last_skip_at":null,"claim":null,"revision":2,"created_at":"2026-09-29T23:01:39.194Z","updated_at":"2026-09-29T23:01:49.626Z","created_by":{"user":"alex","agent":null}},"why":"last done just now","label":"last done just now","urgent":false,"stale":false,"snoozed_until":null,"pinned":false},"done":true}],"new_items":[],"also":[],"more_count":0,"urgent":[{"task":{"id":"mygvj5ep","seq":1,"title":"ring the vet about Milo","brief":"**Milo** needs a dental.\n\n- call before 5","next_action":"","done_means":"","owner":"alex","visibility":"household","next_actor":{"kind":"user","user":"alex"},"actor_since":"2026-09-29T23:01:39.147Z","state":"waiting","close_reason":"","closed_at":null,"waiting":{"kind":"reply","for":"vet","task_id":null,"since":"2026-09-29T23:01:39.253Z","follow_up":{"date":"2026-10-01"}},"available_from":null,"available_rule":null,"target":null,"target_rule":null,"deadline":{"date":"2026-10-01"},"expires":null,"area":"home","requires":[],"prefers":[],"recurrence":null,"attachments":[],"last_done_at":null,"last_skip_at":null,"claim":null,"revision":2,"created_at":"2026-09-29T23:01:39.147Z","updated_at":"2026-09-29T23:01:39.253Z","created_by":{"user":"alex","agent":null}},"why":"deadline tomorrow","label":"deadline tomorrow","urgent":true,"stale":false,"snoozed_until":null,"pinned":false}],"enough_until":null,"waiting_count":1,"resting_count":0,"away":null}
"""#

private let taskJSON = #"""
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
