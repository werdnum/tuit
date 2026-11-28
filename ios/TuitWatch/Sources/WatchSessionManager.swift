import Foundation
import Observation
import WatchConnectivity
import WidgetKit

/// Bridges WatchConnectivity updates from the iPhone into the watch's App Group snapshot
/// and reloads watchOS complications.
@Observable
final class WatchSessionManager: NSObject {
    static let shared = WatchSessionManager()

    private(set) var snapshot: WidgetNowSnapshot
    private(set) var isRefreshing = false
    private(set) var isReachable = false
    var error: String?

    private var activated = false

    private override init() {
        snapshot = WidgetSnapshotStore.shared.load(area: nil) ?? .signedOut()
        super.init()
    }

    func activate() {
        guard !activated, WCSession.isSupported() else { return }
        activated = true
        let session = WCSession.default
        session.delegate = self
        session.activate()
        if let incoming = WatchWire.decode(session.receivedApplicationContext) {
            apply(incoming)
        }
    }

    func apply(_ incoming: WidgetNowSnapshot) {
        snapshot = incoming
        if incoming.signedIn {
            WidgetSnapshotStore.shared.save(incoming)
        } else {
            WidgetSnapshotStore.shared.clearAll()
            WidgetSnapshotStore.shared.save(incoming)
        }
        if let tz = incoming.timezone.flatMap(TimeZone.init(identifier:)) {
            Household.zone = tz
        }
        WidgetCenter.shared.reloadAllTimelines()
    }

    func refreshFromPhone() async {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated, session.isReachable else { return }
        isRefreshing = true
        error = nil
        defer { isRefreshing = false }

        await withCheckedContinuation { continuation in
            session.sendMessage([WatchWire.commandKey: WatchWire.commandRefresh]) { reply in
                let incoming = WatchWire.decode(reply)
                let err = reply[WatchWire.errorKey] as? String
                Task { @MainActor in
                    if let incoming {
                        self.apply(incoming)
                    } else if let err {
                        self.error = err
                    }
                    continuation.resume()
                }
            } errorHandler: { err in
                let message = err.localizedDescription
                Task { @MainActor in
                    self.error = message
                    continuation.resume()
                }
            }
        }
    }

    func completeTask(id: String, expectedRevision: Int) async -> Bool {
        guard WCSession.isSupported() else { return false }
        let session = WCSession.default
        guard session.activationState == .activated, session.isReachable else {
            error = "iPhone not reachable."
            return false
        }
        isRefreshing = true
        error = nil
        defer { isRefreshing = false }

        return await withCheckedContinuation { continuation in
            let message: [String: Any] = [
                WatchWire.commandKey: WatchWire.commandComplete,
                WatchWire.taskIDKey: id,
                WatchWire.revisionKey: expectedRevision,
            ]
            session.sendMessage(message) { reply in
                let incoming = WatchWire.decode(reply)
                let err = reply[WatchWire.errorKey] as? String
                Task { @MainActor in
                    if let incoming {
                        self.apply(incoming)
                        continuation.resume(returning: true)
                    } else {
                        self.error = err ?? "Couldn't complete task."
                        continuation.resume(returning: false)
                    }
                }
            } errorHandler: { err in
                let message = err.localizedDescription
                Task { @MainActor in
                    self.error = message
                    continuation.resume(returning: false)
                }
            }
        }
    }
}

extension WatchSessionManager: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: (any Error)?
    ) {
        let reachable = session.isReachable
        let incoming = WatchWire.decode(session.receivedApplicationContext)
        Task { @MainActor in
            self.isReachable = reachable
            if let incoming {
                self.apply(incoming)
            }
        }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        let reachable = session.isReachable
        Task { @MainActor in
            self.isReachable = reachable
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        guard let incoming = WatchWire.decode(applicationContext) else { return }
        Task { @MainActor in
            self.apply(incoming)
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        guard let incoming = WatchWire.decode(userInfo) else { return }
        Task { @MainActor in
            self.apply(incoming)
        }
    }
}
