import CryptoKit
import Darwin
import Foundation

/// The identity provider the app signs in with (Keycloak), from Info.plist (Project.swift).
struct IdentityProvider: Codable {
    static let issuer = Bundle.main.object(forInfoDictionaryKey: "TuitIssuer") as? String ?? ""
    static let clientId = Bundle.main.object(forInfoDictionaryKey: "TuitClientId") as? String ?? ""

    var authorizationEndpoint: URL
    var tokenEndpoint: URL
    var revocationEndpoint: URL?

    private enum CodingKeys: String, CodingKey {
        case authorizationEndpoint = "authorization_endpoint"
        case tokenEndpoint = "token_endpoint"
        case revocationEndpoint = "revocation_endpoint"
    }

    static func discover() async throws -> IdentityProvider {
        guard let issuer = URL(string: issuer) else { throw APIError.server("This build has no identity provider.") }
        let url = issuer.appending(path: ".well-known/openid-configuration")
        let (data, response) = try await URLSession.shared.data(from: url)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw APIError.server("The sign-in service isn't answering. Try again later.")
        }
        return try JSONDecoder().decode(IdentityProvider.self, from: data)
    }
}

/// What the app presents on /api. Either tokens from the identity provider — a short-lived
/// access token, renewed with the refresh token kept in the Keychain — or, for a server
/// without that sign-in (e.g. `npm run local`), a pasted Tuit personal token.
final class Credentials {
    private static let refreshKey = "tuit_refresh_token"
    private static let providerKey = "tuit_identity_provider"
    private static let staticKey = "tuit_token"
    private static let offlineKey = "tuit_offline_identity"
    private static let accessTokenKey = "tuit_access_token"
    private static let accessExpiresKey = "tuit_access_expires"
    let offlineIdentity: String

    private enum Kind {
        case provider(IdentityProvider, refresh: String)
        case pasted(String)
    }

    private var kind: Kind
    private var access: (token: String, expires: Date)?
    private var refreshing: Task<String, Error>?

    private init(_ kind: Kind, debugIdentity: String? = nil) {
        self.kind = kind
        if let debugIdentity { offlineIdentity = debugIdentity }
        else {
            let identity = Keychain.read(Self.offlineKey) ?? UUID().uuidString
            Keychain.write(Self.offlineKey, identity)
            offlineIdentity = identity
        }
    }

    /// Whatever the Keychain holds from an earlier sign-in, if anything.
    static func stored() -> Credentials? {
        if let refresh = Keychain.read(refreshKey),
           let json = Keychain.read(providerKey),
           let provider = try? JSONDecoder().decode(IdentityProvider.self, from: Data(json.utf8)) {
            let c = Credentials(.provider(provider, refresh: refresh))
            c.access = readCachedAccess()
            return c
        }
        if let token = Keychain.read(staticKey) { return Credentials(.pasted(token)) }
        return nil
    }

    static func signedIn(_ provider: IdentityProvider, _ grant: TokenGrant) -> Credentials? {
        guard let refresh = grant.refreshToken else { return nil }
        clear()
        Keychain.write(refreshKey, refresh)
        Keychain.write(providerKey, String(decoding: try! JSONEncoder().encode(provider), as: UTF8.self))
        let expires = Date.now.addingTimeInterval(TimeInterval(grant.expiresIn))
        writeCachedAccess(token: grant.accessToken, expires: expires)
        let c = Credentials(.provider(provider, refresh: refresh))
        c.access = (grant.accessToken, expires)
        return c
    }

    static func pasted(_ token: String) -> Credentials {
        clear()
        Keychain.write(staticKey, token)
        return Credentials(.pasted(token))
    }

    #if DEBUG
    static func debug(_ token: String) -> Credentials { Credentials(.pasted(token), debugIdentity: SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()) }
    #endif

    static func clear() {
        for key in [refreshKey, providerKey, staticKey, offlineKey, accessTokenKey, accessExpiresKey] {
            Keychain.delete(key)
        }
    }

    private static func readCachedAccess() -> (token: String, expires: Date)? {
        guard let token = Keychain.read(accessTokenKey),
              let raw = Keychain.read(accessExpiresKey),
              let interval = TimeInterval(raw) else { return nil }
        return (token, Date(timeIntervalSince1970: interval))
    }

    private static func writeCachedAccess(token: String, expires: Date) {
        Keychain.write(accessTokenKey, token)
        Keychain.write(accessExpiresKey, String(expires.timeIntervalSince1970))
    }

    /// A token to send now. Renews the access token a little before it lapses; several callers
    /// (and the widget extension) share one renewal via Keychain cache + file lock.
    func accessToken(forceRefresh: Bool = false) async throws -> String {
        switch kind {
        case .pasted(let token):
            return token
        case .provider(let provider, let refresh):
            if !forceRefresh, let access, access.expires > .now.addingTimeInterval(30) {
                return access.token
            }
            if !forceRefresh, let cached = Self.readCachedAccess(), cached.expires > .now.addingTimeInterval(30) {
                access = cached
                return cached.token
            }
            if let refreshing { return try await refreshing.value }
            let task = Task { try await self.renew(provider, refresh, forceRefresh: forceRefresh) }
            refreshing = task
            defer { refreshing = nil }
            return try await task.value
        }
    }

    private func renew(_ provider: IdentityProvider, _ refresh: String, forceRefresh: Bool) async throws -> String {
        let lockFD = try await Self.acquireRefreshLock()
        defer { Self.releaseRefreshLock(lockFD) }

        // Another process (app or widget extension) may have rotated/refreshed while we waited.
        if !forceRefresh, let cached = Self.readCachedAccess(), cached.expires > .now.addingTimeInterval(30) {
            access = cached
            if let latest = Keychain.read(Self.refreshKey) {
                kind = .provider(provider, refresh: latest)
            }
            return cached.token
        }
        let currentRefresh = Keychain.read(Self.refreshKey) ?? refresh
        let grant: TokenGrant
        do {
            grant = try await TokenGrant.request(provider.tokenEndpoint, [
                "grant_type": "refresh_token",
                "refresh_token": currentRefresh,
                "client_id": IdentityProvider.clientId,
            ])
        } catch APIError.unauthenticated {
            // Revoked, or unused for longer than the provider keeps offline sessions.
            // Only clear if the stored refresh token hasn't already been replaced.
            if Keychain.read(Self.refreshKey) == currentRefresh {
                Self.clear()
            }
            throw APIError.unauthenticated
        }
        if let rotated = grant.refreshToken, rotated != currentRefresh {
            Keychain.write(Self.refreshKey, rotated)
            kind = .provider(provider, refresh: rotated)
        } else if currentRefresh != refresh {
            kind = .provider(provider, refresh: currentRefresh)
        }
        let expires = Date.now.addingTimeInterval(TimeInterval(grant.expiresIn))
        Self.writeCachedAccess(token: grant.accessToken, expires: expires)
        access = (grant.accessToken, expires)
        return grant.accessToken
    }

    /// Non-blocking cross-process advisory file lock so app and widget never race on refresh rotation.
    /// Waits past `TokenGrant.post`'s 20s request timeout and fails as a transport error instead of
    /// ever proceeding unlocked with a potentially stale rotating refresh token.
    private static func acquireRefreshLock() async throws -> Int32 {
        let url = TuitGroup.refreshLockURL
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let fd = open(url.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard fd >= 0 else {
            throw APIError.transport("Couldn't coordinate sign-in refresh.")
        }
        var acquired = false
        defer { if !acquired { close(fd) } }
        let deadline = Date.now.addingTimeInterval(25)
        while flock(fd, LOCK_EX | LOCK_NB) != 0 {
            let err = errno
            if err != EWOULDBLOCK && err != EINTR {
                throw APIError.transport("Couldn't coordinate sign-in refresh.")
            }
            if Date.now >= deadline {
                throw APIError.transport("Timed out waiting for another Tuit refresh to finish.")
            }
            try await Task.sleep(for: .milliseconds(50))
        }
        acquired = true
        return fd
    }

    private static func releaseRefreshLock(_ fd: Int32) {
        guard fd >= 0 else { return }
        flock(fd, LOCK_UN)
        close(fd)
    }

    var canRefresh: Bool {
        if case .provider = kind { return true }
        return false
    }

    /// Ends the provider's session for this app. Best effort: signing out locally always works.
    func revoke() async {
        guard case .provider(let provider, let refresh) = kind, let endpoint = provider.revocationEndpoint else { return }
        let currentRefresh = Keychain.read(Self.refreshKey) ?? refresh
        _ = try? await TokenGrant.post(endpoint, [
            "token": currentRefresh,
            "token_type_hint": "refresh_token",
            "client_id": IdentityProvider.clientId,
        ])
    }
}

/// An OAuth token endpoint's answer.
struct TokenGrant: Decodable {
    var accessToken: String
    var refreshToken: String?
    var expiresIn: Int

    private enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case expiresIn = "expires_in"
    }

    static func request(_ endpoint: URL, _ form: [String: String]) async throws -> TokenGrant {
        let (data, status) = try await post(endpoint, form)
        if status == 400 || status == 401 {
            // invalid_grant: the code or refresh token is no good any more.
            throw APIError.unauthenticated
        }
        guard status == 200 else { throw APIError.server("The sign-in service said no (HTTP \(status)).") }
        return try JSONDecoder().decode(TokenGrant.self, from: data)
    }

    static func post(_ endpoint: URL, _ form: [String: String]) async throws -> (Data, Int) {
        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.timeoutInterval = 20
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var comps = URLComponents()
        comps.queryItems = form.map { URLQueryItem(name: $0.key, value: $0.value) }
        // URLComponents leaves "+" alone, which a form body would read as a space.
        req.httpBody = Data((comps.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B").utf8)
        do {
            let (data, response) = try await URLSession.shared.data(for: req)
            return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
        } catch {
            throw APIError.transport("Couldn't reach the sign-in service. \(error.localizedDescription)")
        }
    }
}
