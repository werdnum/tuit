import Foundation
import Observation
import UIKit
import UserNotifications

/// Push notifications for this iPhone. The server decides what's worth telling (each person's
/// rules and quiet hours, set on the web); the app only registers its device token and opens
/// the task a notification is about.
@Observable
final class PushRegistration {
    static let shared = PushRegistration()
    private static let enabledKey = "tuit_push_enabled"

    /// The person turned notifications on for this iPhone.
    private(set) var enabled = UserDefaults.standard.bool(forKey: enabledKey)
    /// Why the last attempt didn't work, for Settings to show.
    private(set) var problem: String?
    /// A tapped notification's task, for the root view to open.
    var openTask: String?
    /// How to reach the server as whoever is signed in.
    var api: () -> API? = { nil }
    private var token: String?

    /// Development builds get sandbox tokens. A Release build signed for development does too;
    /// the server tries the other environment once when a token doesn't fit and remembers.
    private static let environment: String = {
        #if DEBUG
        "sandbox"
        #else
        "production"
        #endif
    }()

    func turnOn() async {
        problem = nil
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            guard granted else {
                problem = "Notifications are off for Tuit in the iPhone's Settings app."
                setEnabled(false)
                return
            }
        } catch {
            problem = error.localizedDescription
            return
        }
        setEnabled(true)
        UIApplication.shared.registerForRemoteNotifications()
    }

    /// Stop this iPhone receiving notifications (also before signing out).
    func turnOff() async {
        setEnabled(false)
        problem = nil
        guard let token, let api = api() else { return }
        _ = try? await api.delete("/notifications/devices/\(token)", Empty()) as Removed
    }

    /// On launch: tokens can change, so a phone that's on registers again.
    func refresh() async {
        guard enabled else { return }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
            problem = "Notifications are off for Tuit in the iPhone's Settings app."
            return
        }
        UIApplication.shared.registerForRemoteNotifications()
    }

    func registered(_ deviceToken: Data) async {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        token = hex
        guard enabled, let api = api() else { return }
        do {
            let body = DeviceBody(token: hex, environment: Self.environment, label: UIDevice.current.name)
            let _: Registered = try await api.post("/notifications/devices", body)
            problem = nil
        } catch {
            problem = error.localizedDescription
        }
    }

    func failed(_ error: Error) {
        problem = "This iPhone couldn't register for notifications: \(error.localizedDescription)"
    }

    private func setEnabled(_ on: Bool) {
        enabled = on
        UserDefaults.standard.set(on, forKey: Self.enabledKey)
    }
}

private struct DeviceBody: Encodable {
    let kind = "apns"
    let token: String
    let environment: String
    let label: String
}

private struct Registered: Decodable { let id: String }
private struct Removed: Decodable { let ok: Bool }

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { await PushRegistration.shared.registered(deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushRegistration.shared.failed(error)
    }

    /// Shown even while Tuit is open: the person may be on another task's screen.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
    ) async {
        let taskId = response.notification.request.content.userInfo["task_id"] as? String
        await MainActor.run { PushRegistration.shared.openTask = taskId }
    }
}
