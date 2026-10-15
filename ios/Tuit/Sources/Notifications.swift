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
    private static let tokenKey = "tuit_push_token"

    /// The person turned notifications on for this iPhone.
    private(set) var enabled = UserDefaults.standard.bool(forKey: enabledKey)
    /// Why the last attempt didn't work, for Settings to show.
    private(set) var problem: String?
    /// A tapped notification's task, for the root view to open.
    var openTask: String?
    /// How to reach the server as whoever is signed in.
    var api: () -> API? = { nil }
    /// Kept across launches so the phone can always withdraw it, even before iOS hands the
    /// token over again.
    private var token: String? = UserDefaults.standard.string(forKey: tokenKey) {
        didSet { UserDefaults.standard.set(token, forKey: Self.tokenKey) }
    }

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

    /// Stop this iPhone receiving notifications (also before signing out). Returns false, and
    /// stays on, when the server couldn't be told: otherwise the phone would keep receiving
    /// notifications while saying it doesn't, possibly for someone who has signed out.
    @discardableResult
    func turnOff() async -> Bool {
        problem = nil
        guard let token else {
            setEnabled(false)
            return true
        }
        guard let api = api() else { return false }
        do {
            _ = try await api.delete("/notifications/devices/\(token)", Empty()) as Removed
        } catch APIError.unauthenticated {
            // This sign-in has lapsed; the device token alone is enough to withdraw the phone.
            guard await forget(token, base: api.base) else { return false }
        } catch {
            problem = "Couldn't reach Tuit to stop notifications on this iPhone: \(error.localizedDescription)"
            return false
        }
        setEnabled(false)
        return true
    }

    private func forget(_ token: String, base: URL) async -> Bool {
        let status = try? await TokenGrant.post(base.appending(path: "notifications/forget"), ["token": token]).1
        guard status == 200 else {
            problem = "Couldn't reach Tuit to stop notifications on this iPhone."
            return false
        }
        return true
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
