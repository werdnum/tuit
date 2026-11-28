import Foundation

/// Shared App Group storage for Tuit across the iOS app + widget extension, and across
/// the watchOS app + complication extension (each device has its own App Group container).
nonisolated enum TuitGroup {
    static let identifier = "group.dev.andrewgarrett.tuit"
    static let serverURLKey = "tuit_server_url"

    /// The shared container directory, falling back to Application Support when running
    /// in an unsigned test host without the App Group entitlement.
    static var containerURL: URL {
        if let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier) {
            return url.appending(path: "Tuit", directoryHint: .isDirectory)
        }
        return URL.applicationSupportDirectory.appending(path: "Tuit/SharedGroup", directoryHint: .isDirectory)
    }

    static var defaults: UserDefaults {
        UserDefaults(suiteName: identifier) ?? .standard
    }

    static var refreshLockURL: URL {
        containerURL.appending(path: "token-refresh.lock")
    }

    static var savedServerURL: String? {
        get {
            defaults.string(forKey: serverURLKey) ?? UserDefaults.standard.string(forKey: serverURLKey)
        }
        set {
            if let newValue, !newValue.isEmpty {
                defaults.set(newValue, forKey: serverURLKey)
            } else {
                defaults.removeObject(forKey: serverURLKey)
            }
        }
    }
}
