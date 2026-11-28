import BackgroundTasks
import Foundation
import WatchConnectivity
import WidgetKit

/// Publishes Tuit Now snapshots to iOS WidgetKit and to the paired Apple Watch via
/// WatchConnectivity, and handles refresh/complete messages initiated on the Watch.
final class WatchSync: NSObject {
    static let shared = WatchSync()
    static let backgroundRefreshID = "dev.andrewgarrett.tuit.refresh"

    /// Optional hooks wired by the active SwiftUI `Session` so watch-triggered actions also
    /// update the in-memory iOS UI immediately.
    var apiProvider: () -> API? = { nil }
    var serverURLProvider: () -> String? = { TuitGroup.savedServerURL }
    var timezoneProvider: () -> String? = { Household.zone.identifier }
    var onRemoteMutation: () -> Void = {}

    private var activated = false
    private var lastComplicationDigest: String?
    private static var backgroundRegistered = false

    private override init() {
        super.init()
    }

    func activate() {
        guard !activated, WCSession.isSupported() else { return }
        activated = true
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    func publish(now: NowView, serverURL: String?, timezone: String?) {
        let snapshot = WidgetNowSnapshot.from(
            now: now,
            serverURL: serverURL ?? serverURLProvider(),
            timezone: timezone ?? timezoneProvider()
        )
        WidgetSnapshotStore.shared.save(snapshot)
        WidgetCenter.shared.reloadAllTimelines()

        // Only unfiltered Now drives the Apple Watch app and complications.
        if now.area == nil {
            pushToWatch(snapshot)
        }
    }

    func publishSignedOut() {
        WidgetSnapshotStore.shared.clearAll()
        let signedOut = WidgetNowSnapshot.signedOut()
        WidgetSnapshotStore.shared.save(signedOut)
        WidgetCenter.shared.reloadAllTimelines()
        pushToWatch(signedOut)
    }

    /// Refreshes unfiltered Now from the server and pushes it to iOS widgets and Apple Watch.
    @discardableResult
    func refreshAndPublish() async -> WidgetNowSnapshot? {
        guard let api = activeAPI() else {
            let signedOut = WidgetNowSnapshot.signedOut()
            return signedOut
        }
        do {
            let now: NowView = try await api.get("/now")
            let snapshot = WidgetNowSnapshot.from(
                now: now,
                serverURL: serverURLProvider() ?? api.base.absoluteString,
                timezone: timezoneProvider()
            )
            WidgetSnapshotStore.shared.save(snapshot)
            WidgetCenter.shared.reloadAllTimelines()
            pushToWatch(snapshot)
            return snapshot
        } catch APIError.unauthenticated {
            publishSignedOut()
            return .signedOut()
        } catch {
            return WidgetSnapshotStore.shared.load(area: nil)
        }
    }

    private func activeAPI() -> API? {
        if let api = apiProvider() { return api }
        guard let credentials = Credentials.stored(),
              let server = TuitGroup.savedServerURL ?? (Bundle.main.object(forInfoDictionaryKey: "TuitServer") as? String),
              let base = URL(string: server)
        else { return nil }
        return API(base: base, credentials: credentials, offlineStore: nil)
    }

    private func pushToWatch(_ snapshot: WidgetNowSnapshot) {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else { return }
        guard let payload = WatchWire.encode(snapshot) else { return }

        try? session.updateApplicationContext(payload)

        // Use the high-priority complication transfer budget only when glanceable state changed.
        let digest = "\(snapshot.signedIn)|\(snapshot.urgentCount)|\(snapshot.remainingCount)|\(snapshot.donePlanCount)/\(snapshot.totalPlanCount)|\(snapshot.isResting)|\(snapshot.topRow?.id ?? "")"
        if digest != lastComplicationDigest,
           session.isComplicationEnabled,
           session.remainingComplicationUserInfoTransfers > 0 {
            lastComplicationDigest = digest
            session.transferCurrentComplicationUserInfo(payload)
        }
    }

    // MARK: Background App Refresh

    static func registerBackgroundRefresh() {
        guard !backgroundRegistered else { return }
        backgroundRegistered = true
        BGTaskScheduler.shared.register(forTaskWithIdentifier: backgroundRefreshID, using: nil) { task in
            guard let refresh = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            Task { @MainActor in
                scheduleBackgroundRefresh()
                let worker = Task { @MainActor in
                    _ = await WatchSync.shared.refreshAndPublish()
                }
                refresh.expirationHandler = {
                    worker.cancel()
                }
                await worker.value
                refresh.setTaskCompleted(success: !worker.isCancelled)
            }
        }
    }

    static func scheduleBackgroundRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: backgroundRefreshID)
        request.earliestBeginDate = Date.now.addingTimeInterval(15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }
}

extension WatchSync: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: (any Error)?
    ) {
        guard activationState == .activated else { return }
        Task { @MainActor in
            if let existing = WidgetSnapshotStore.shared.load(area: nil) {
                self.pushToWatch(existing)
            }
        }
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    nonisolated func session(
        _ session: WCSession,
        didReceiveMessage message: [String: Any],
        replyHandler: @escaping ([String: Any]) -> Void
    ) {
        let command = message[WatchWire.commandKey] as? String
        let taskID = message[WatchWire.taskIDKey] as? String
        let expectedRevision = message[WatchWire.revisionKey] as? Int
        nonisolated(unsafe) let reply = replyHandler

        Task { @MainActor in
            switch command {
            case WatchWire.commandRefresh:
                if let snapshot = await self.refreshAndPublish(),
                   let encoded = WatchWire.encode(snapshot) {
                    reply(encoded)
                } else {
                    reply([WatchWire.errorKey: "Not signed in on iPhone."])
                }

            case WatchWire.commandComplete:
                guard let taskID, let api = self.activeAPI() else {
                    reply([WatchWire.errorKey: "Sign in on iPhone first."])
                    return
                }
                do {
                    let _: TaskView = try await api.post(
                        "/tasks/\(taskID)/complete",
                        CompleteBody(expectedRevision: expectedRevision)
                    )
                    self.onRemoteMutation()
                    if let snapshot = await self.refreshAndPublish(),
                       let encoded = WatchWire.encode(snapshot) {
                        reply(encoded)
                    } else {
                        reply([WatchWire.errorKey: "Completed, but couldn't refresh Now."])
                    }
                } catch APIError.queued {
                    self.onRemoteMutation()
                    if let existing = WidgetSnapshotStore.shared.load(area: nil),
                       let encoded = WatchWire.encode(existing) {
                        reply(encoded)
                    } else {
                        reply([WatchWire.errorKey: "Saved on iPhone. Will sync when online."])
                    }
                } catch {
                    reply([WatchWire.errorKey: error.localizedDescription])
                }

            default:
                reply([WatchWire.errorKey: "Unknown watch command."])
            }
        }
    }
}
