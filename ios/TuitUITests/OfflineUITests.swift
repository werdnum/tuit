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
        XCTAssertTrue(app.staticTexts[title].firstMatch.waitForExistence(timeout: 15))
        app.terminate()
    }
}
