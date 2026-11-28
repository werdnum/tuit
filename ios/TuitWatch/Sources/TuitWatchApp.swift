import SwiftUI
import WatchKit

@main
struct TuitWatchApp: App {
    @WKApplicationDelegateAdaptor(WatchAppDelegate.self) private var delegate
    @State private var store = WatchSessionManager.shared

    var body: some Scene {
        WindowGroup {
            WatchNowView()
                .environment(store)
                .tint(Color("AccentColor"))
                .task {
                    store.activate()
                }
        }
    }
}

final class WatchAppDelegate: NSObject, WKApplicationDelegate {
    func applicationDidFinishLaunching() {
        WatchSessionManager.shared.activate()
        Self.scheduleBackgroundRefresh()
    }

    func handle(_ backgroundTasks: Set<WKRefreshBackgroundTask>) {
        for task in backgroundTasks {
            if let refresh = task as? WKApplicationRefreshBackgroundTask {
                Task { @MainActor in
                    WatchSessionManager.shared.activate()
                    await WatchSessionManager.shared.refreshFromPhone()
                    Self.scheduleBackgroundRefresh()
                    refresh.setTaskCompletedWithSnapshot(false)
                }
            } else {
                task.setTaskCompletedWithSnapshot(false)
            }
        }
    }

    static func scheduleBackgroundRefresh() {
        let next = Date.now.addingTimeInterval(30 * 60)
        WKApplication.shared().scheduleBackgroundRefresh(withPreferredDate: next, userInfo: nil) { _ in }
    }
}
