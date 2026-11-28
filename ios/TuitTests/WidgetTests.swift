import Foundation
import Testing
@testable import Tuit

@Suite @MainActor
struct WidgetTests {
    private func makeTask(
        id: String,
        title: String,
        area: String? = nil,
        brief: String = "",
        state: String = "open",
        openParts: Int? = nil
    ) -> TaskItem {
        TaskItem(
            id: id,
            title: title,
            brief: brief,
            nextAction: "",
            doneMeans: "",
            owner: "alex",
            visibility: "household",
            nextActor: .user("alex"),
            actorSince: "2026-10-01T00:00:00Z",
            state: state,
            closeReason: "",
            closedAt: nil,
            waiting: nil,
            availableFrom: nil,
            target: nil,
            deadline: nil,
            expires: nil,
            area: area,
            requires: [],
            prefers: [],
            recurrence: nil,
            attachments: [],
            openParts: openParts,
            lastDoneAt: nil,
            lastSkipAt: nil,
            claim: nil,
            revision: 3,
            createdAt: "2026-10-01T00:00:00Z",
            updatedAt: "2026-10-01T00:00:00Z",
            createdBy: Author(user: "alex", agent: nil)
        )
    }

    private func makeItem(
        id: String,
        title: String,
        why: String = "",
        urgent: Bool = false,
        pinned: Bool = false,
        area: String? = nil,
        brief: String = "",
        openParts: Int? = nil
    ) -> QueueItem {
        QueueItem(
            task: makeTask(id: id, title: title, area: area, brief: brief, openParts: openParts),
            why: why,
            label: why,
            urgent: urgent,
            stale: false,
            snoozedUntil: nil,
            pinned: pinned
        )
    }

    @Test func snapshotPrioritizesUrgentPlanNewAndDeduplicates() {
        let urgent = makeItem(id: "u1", title: "Renew passport", why: "deadline tomorrow", urgent: true)
        let planOpen = makeItem(id: "p1", title: "Water plants", why: "last done 4d ago")
        let planDone = makeItem(id: "p2", title: "Pay electricity", why: "target today")
        let newOne = makeItem(id: "n1", title: "Reply to builder", why: "handed to you")
        let alsoOne = makeItem(id: "a1", title: "Organize garage", why: "")

        let now = NowView(
            date: "2026-10-01",
            area: nil,
            areas: ["home", "tuit"],
            plan: [
                NowView.PlanRow(item: urgent, done: false),
                NowView.PlanRow(item: planOpen, done: false),
                NowView.PlanRow(item: planDone, done: true),
            ],
            newItems: [newOne],
            also: [alsoOne],
            moreCount: 2,
            urgent: [urgent],
            enoughUntil: nil,
            waitingCount: 1,
            restingCount: 0,
            away: nil
        )
        let snap = WidgetNowSnapshot.from(now: now, serverURL: "https://tuit.example.com", timezone: "Australia/Sydney")

        #expect(snap.urgentCount == 1)
        #expect(snap.totalPlanCount == 3)
        #expect(snap.donePlanCount == 1)
        #expect(snap.remainingCount == 3) // u1, p1, n1 (deduplicated)
        #expect(snap.actionableRows.map(\.id) == ["u1", "p1", "n1"])
        #expect(snap.displayRows(limit: 5, includeDonePlan: true, includeAlso: true).map(\.id) == ["u1", "p1", "n1", "p2", "a1"])
        #expect(snap.inlineSummary == "Urgent: Renew passport")
        #expect(snap.cornerLabel == "1 urgent")
    }

    @Test func restingSnapshotHidesNonUrgentItemsAndSchedulesEarlyRefresh() throws {
        let urgent = makeItem(id: "u1", title: "Urgent task", why: "deadline today", urgent: true)
        let planOpen = makeItem(id: "p1", title: "Regular task")
        let base = try #require(Fmt.date("2026-10-01T10:00:00Z"))
        let untilSoon = "2026-10-01T10:05:00Z"

        let restingWithoutUrgent = WidgetNowSnapshot.from(
            now: NowView(
                date: "2026-10-01",
                area: nil,
                areas: [],
                plan: [NowView.PlanRow(item: planOpen, done: false)],
                newItems: [],
                also: [],
                moreCount: 0,
                urgent: [],
                enoughUntil: untilSoon,
                waitingCount: 0,
                restingCount: 1,
                away: nil
            ),
            serverURL: nil,
            timezone: nil
        )
        #expect(restingWithoutUrgent.isResting)
        #expect(restingWithoutUrgent.actionableRows.isEmpty)
        #expect(restingWithoutUrgent.remainingCount == 0)
        #expect(restingWithoutUrgent.inlineSummary == "Enough for now")
        #expect(restingWithoutUrgent.cornerLabel == "Resting")
        let next = restingWithoutUrgent.nextRefreshDate(from: base)
        let expected = try #require(Fmt.date(untilSoon)).addingTimeInterval(5)
        #expect(abs(next.timeIntervalSince(expected)) < 1)

        let restingWithUrgent = WidgetNowSnapshot.from(
            now: NowView(
                date: "2026-10-01",
                area: nil,
                areas: [],
                plan: [NowView.PlanRow(item: planOpen, done: false)],
                newItems: [],
                also: [],
                moreCount: 0,
                urgent: [urgent],
                enoughUntil: untilSoon,
                waitingCount: 0,
                restingCount: 1,
                away: nil
            ),
            serverURL: nil,
            timezone: nil
        )
        #expect(restingWithUrgent.actionableRows.map(\.id) == ["u1"])
        #expect(restingWithUrgent.remainingCount == 1)
    }

    @Test func quickCompleteRespectsOpenPartsAndDoneState() {
        let normal = WidgetNowRow(item: makeItem(id: "a", title: "Normal"), section: .plan, done: false)
        let done = WidgetNowRow(item: makeItem(id: "b", title: "Done"), section: .plan, done: true)
        let parentWithParts = WidgetNowRow(item: makeItem(id: "c", title: "Parent", openParts: 2), section: .plan, done: false)

        #expect(normal.canQuickComplete)
        #expect(!done.canQuickComplete)
        #expect(!parentWithParts.canQuickComplete)
    }

    @Test func snapshotStorePersistsDefaultAndAreaSnapshotsAndClearsAll() {
        let dir = FileManager.default.temporaryDirectory.appending(path: "tuit-widget-tests-\(UUID())")
        let store = WidgetSnapshotStore(directory: dir)
        defer { try? FileManager.default.removeItem(at: dir) }

        let allNow = NowView(
            date: "2026-10-01", area: nil, areas: ["home", "tuit"],
            plan: [], newItems: [], also: [], moreCount: 0,
            urgent: [], enoughUntil: nil, waitingCount: 0, restingCount: 0, away: nil
        )
        let homeNow = NowView(
            date: "2026-10-01", area: "home", areas: ["home", "tuit"],
            plan: [], newItems: [], also: [], moreCount: 0,
            urgent: [], enoughUntil: nil, waitingCount: 0, restingCount: 0, away: nil
        )
        store.save(.from(now: allNow, serverURL: "https://tuit.example.com", timezone: "Australia/Sydney"))
        store.save(.from(now: homeNow, serverURL: "https://tuit.example.com", timezone: "Australia/Sydney"))

        #expect(store.knownAreas() == ["home", "tuit"])
        #expect(store.load(area: nil)?.area == nil)
        #expect(store.load(area: "home")?.area == "home")

        store.clearAll()
        #expect(store.load(area: nil) == nil)
        #expect(store.load(area: "home") == nil)
    }

    @Test func watchWireTrimsLargePayloadsAndRoundTrips() throws {
        let longBrief = String(repeating: "a", count: 800)
        let alsoItems = (1...20).map { i in
            makeItem(id: "a\(i)", title: "Task \(i)", brief: longBrief)
        }
        let now = NowView(
            date: "2026-10-01",
            area: nil,
            areas: ["home"],
            plan: [NowView.PlanRow(item: makeItem(id: "p1", title: "Plan 1", brief: longBrief), done: false)],
            newItems: [],
            also: alsoItems,
            moreCount: 5,
            urgent: [],
            enoughUntil: nil,
            waitingCount: 2,
            restingCount: 0,
            away: nil
        )
        let original = WidgetNowSnapshot.from(now: now, serverURL: "https://tuit.example.com", timezone: "Australia/Sydney")
        let encoded = try #require(WatchWire.encode(original))
        let decoded = try #require(WatchWire.decode(encoded))

        #expect(decoded.now?.also.count == 12)
        #expect(decoded.now?.moreCount == 13) // 5 + (20 - 12)
        #expect((decoded.now?.plan.first?.item.task.brief.count ?? 0) <= 301)
    }

    @Test func appNavigationOpenNowAndCaptureDeepLinks() {
        let nav = AppNavigation()
        nav.tab = "tasks"
        nav.nowPath = ["old-task"]
        let beforeFocus = nav.captureFocusTick

        nav.openNow(area: "#Home")
        #expect(nav.tab == "now")
        #expect(nav.nowArea == "home")
        #expect(nav.nowPath.isEmpty)
        #expect(nav.captureFocusTick == beforeFocus)

        nav.openCapture(area: nil)
        #expect(nav.tab == "now")
        #expect(nav.nowArea == nil)
        #expect(nav.captureFocusTick == beforeFocus + 1)
    }

    @Test func deepLinkURLsIncludeOptionalArea() {
        let all = WidgetNowSnapshot.placeholder
        #expect(all.deepLinkURL.absoluteString == "tuit://now")
        #expect(all.captureURL.absoluteString == "tuit://capture")
        #expect(WidgetNowSnapshot.taskURL(id: "abc123").absoluteString == "tuit://tasks/abc123")

        var narrowed = all
        narrowed.area = "home"
        #expect(narrowed.deepLinkURL.absoluteString == "tuit://now?area=home")
        #expect(narrowed.captureURL.absoluteString == "tuit://capture?area=home")
    }
}
