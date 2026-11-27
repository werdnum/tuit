import XCTest

nonisolated final class OfflineUITests: XCTestCase {
    struct Config: Decodable { var base: String; var token: String; var taskID: String }

    @MainActor func testOfflineColdLaunchCaptureAndReconnect() async throws {
        continueAfterFailure = false
        guard let (data, _) = try? await URLSession.shared.data(from: URL(string: "http://localhost:18089/config")!) else {
            throw XCTSkip("Run npm run test:ios:offline for the real-backend offline UI test")
        }
        let config = try JSONDecoder().decode(Config.self, from: data)
        func mode(_ value: String) async throws {
            _ = try await URLSession.shared.data(from: URL(string: config.base + "/mode/" + value)!)
        }
        try await mode("online")
        let app = XCUIApplication()
        app.launchEnvironment = ["TUIT_SERVER": config.base, "TUIT_TOKEN": config.token, "TUIT_RESET_OFFLINE": "1"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Offline fixture task"].firstMatch.waitForExistence(timeout: 20))
        // Open detail once and wait for its server-backed brief/history to load.
        app.staticTexts["Offline fixture task"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["A saved brief for a flight"].waitForExistence(timeout: 10))
        app.terminate()
        try await mode("offline")
        app.launchEnvironment["TUIT_RESET_OFFLINE"] = nil
        app.launch()
        XCTAssertTrue(app.staticTexts["Offline fixture task"].firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Offline · showing saved data"].waitForExistence(timeout: 10))
        app.staticTexts["Offline fixture task"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["A saved brief for a flight"].waitForExistence(timeout: 10))
        app.navigationBars.buttons.firstMatch.tap()
        let capture = app.descendants(matching: .any).matching(identifier: "capture-field").firstMatch
        guard capture.waitForExistence(timeout: 10) else {
            XCTFail("Capture field missing after navigating back")
            return
        }
        capture.tap()
        let title = "Captured during flight \(UUID().uuidString.prefix(8))"
        capture.typeText(title + "\n")
        app.tabBars.buttons["Settings"].tap()
        XCTAssertTrue(app.staticTexts[title].waitForExistence(timeout: 10))
        app.terminate()
        app.launch()
        app.tabBars.buttons["Settings"].tap()
        XCTAssertTrue(app.staticTexts[title].waitForExistence(timeout: 10))
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "Durable offline capture after cold launch"
        attachment.lifetime = .keepAlways
        add(attachment)
        try await mode("online")
        // Smaller CI simulators may place this row under the floating tab bar.
        // Wait for any foreground replay to finish and bring the control fully into view.
        app.swipeUp()
        let sync = app.buttons["Sync now"]
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true AND hittable == true"), object: sync)
        guard await XCTWaiter.fulfillment(of: [ready], timeout: 30) == .completed else {
            XCTFail("Sync control did not become ready")
            return
        }
        sync.tap()
        XCTAssertTrue(app.staticTexts["Everything is synced."].waitForExistence(timeout: 30))
        app.tabBars.buttons["Tasks"].tap()
        let capturedRow = app.staticTexts[title].firstMatch
        if !capturedRow.waitForExistence(timeout: 15) {
            app.swipeUp()
            XCTAssertTrue(capturedRow.waitForExistence(timeout: 10))
        }
        app.terminate()
    }

    @MainActor func testBrowseTasksAndAreaBridges() async throws {
        continueAfterFailure = false
        guard let (data, _) = try? await URLSession.shared.data(from: URL(string: "http://localhost:18089/config")!) else {
            throw XCTSkip("Run npm run test:ios:offline for the real-backend UI test")
        }
        let config = try JSONDecoder().decode(Config.self, from: data)
        func request(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> [String: Any] {
            var req = URLRequest(url: URL(string: config.base + path)!)
            req.httpMethod = method
            req.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
            if let body {
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                req.httpBody = try JSONSerialization.data(withJSONObject: body)
            }
            let (respData, _) = try await URLSession.shared.data(for: req)
            return (try? JSONSerialization.jsonObject(with: respData) as? [String: Any]) ?? [:]
        }
        _ = try await URLSession.shared.data(from: URL(string: config.base + "/mode/online")!)

        let area = "a\(UUID().uuidString.prefix(5).lowercased())"
        let mineTitle = "My \(area) check"
        let agentTitle = "Agent \(area) scan"
        let doneTitle = "Done \(area) patch"
        let mineCreated = try await request("POST", "/api/tasks", body: ["title": mineTitle, "area": area])
        let mineId = (mineCreated["task"] as? [String: Any])?["id"] as? String ?? ""
        let agentCreated = try await request("POST", "/api/tasks", body: ["title": agentTitle, "area": area, "next_actor": "agent:claude"])
        let agentId = (agentCreated["task"] as? [String: Any])?["id"] as? String ?? ""
        let doneCreated = try await request("POST", "/api/tasks", body: ["title": doneTitle, "area": area])
        let doneId = (doneCreated["task"] as? [String: Any])?["id"] as? String ?? ""
        _ = try await request("POST", "/api/tasks/\(doneId)/complete", body: [:])
        _ = try await request("PATCH", "/api/areas/\(area)", body: ["hidden_by_default": true])

        let app = XCUIApplication()
        app.launchEnvironment = ["TUIT_SERVER": config.base, "TUIT_TOKEN": config.token, "TUIT_RESET_OFFLINE": "1"]
        app.launch()

        // Tap the hidden area chip on Now -> shows my task and bridges directly to Tasks for the rest.
        let areaChip = app.buttons["#\(area)"].firstMatch
        XCTAssertTrue(areaChip.waitForExistence(timeout: 20))
        areaChip.tap()
        XCTAssertTrue(app.staticTexts[mineTitle].firstMatch.waitForExistence(timeout: 20))
        XCTAssertFalse(app.staticTexts[agentTitle].exists)

        let browseArea = app.buttons["browse-area-button"].firstMatch
        XCTAssertTrue(browseArea.waitForExistence(timeout: 10))
        browseArea.tap()

        // Lands on Tasks filtered to #area, showing both mine and the agent's task.
        XCTAssertTrue(app.staticTexts[agentTitle].firstMatch.waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts[mineTitle].firstMatch.exists)
        XCTAssertFalse(app.staticTexts[doneTitle].exists)

        // Switching to Closed in #area shows the completed task.
        let closedChip = app.buttons["state-chip-closed"].firstMatch
        XCTAssertTrue(closedChip.waitForExistence(timeout: 10))
        closedChip.tap()
        XCTAssertTrue(app.staticTexts[doneTitle].firstMatch.waitForExistence(timeout: 15))
        XCTAssertFalse(app.staticTexts[agentTitle].exists)

        // Tapping the area badge on a task detail page jumps straight to active Tasks in that area.
        app.staticTexts[doneTitle].firstMatch.tap()
        let badge = app.buttons["task-area-badge"].firstMatch
        XCTAssertTrue(badge.waitForExistence(timeout: 10))
        badge.tap()
        XCTAssertTrue(app.staticTexts[agentTitle].firstMatch.waitForExistence(timeout: 15))
        app.terminate()

        // Clean up active tasks so subsequent UI tests start with a compact list.
        if !mineId.isEmpty { _ = try? await request("POST", "/api/tasks/\(mineId)/complete", body: [:]) }
        if !agentId.isEmpty { _ = try? await request("POST", "/api/tasks/\(agentId)/complete", body: [:]) }
    }
}
