import Foundation
import CryptoKit

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
            return Credentials(.provider(provider, refresh: refresh))
        }
        if let token = Keychain.read(staticKey) { return Credentials(.pasted(token)) }
        return nil
    }

    static func signedIn(_ provider: IdentityProvider, _ grant: TokenGrant) -> Credentials? {
        guard let refresh = grant.refreshToken else { return nil }
        clear()
        Keychain.write(refreshKey, refresh)
        Keychain.write(providerKey, String(decoding: try! JSONEncoder().encode(provider), as: UTF8.self))
        let c = Credentials(.provider(provider, refresh: refresh))
        c.access = (grant.accessToken, Date.now.addingTimeInterval(TimeInterval(grant.expiresIn)))
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
        for key in [refreshKey, providerKey, staticKey, offlineKey] { Keychain.delete(key) }
    }

    /// A token to send now. Renews the access token a little before it lapses; several callers
    /// share one renewal.
    func accessToken(forceRefresh: Bool = false) async throws -> String {
        switch kind {
        case .pasted(let token):
            return token
        case .provider(let provider, let refresh):
            if !forceRefresh, let access, access.expires > .now.addingTimeInterval(30) {
                return access.token
            }
            if let refreshing { return try await refreshing.value }
            let task = Task { try await self.renew(provider, refresh) }
            refreshing = task
            defer { refreshing = nil }
            return try await task.value
        }
    }

    private func renew(_ provider: IdentityProvider, _ refresh: String) async throws -> String {
        let grant: TokenGrant
        do {
            grant = try await TokenGrant.request(provider.tokenEndpoint, [
                "grant_type": "refresh_token",
                "refresh_token": refresh,
                "client_id": IdentityProvider.clientId,
            ])
        } catch APIError.unauthenticated {
            // Revoked, or unused for longer than the provider keeps offline sessions.
            Self.clear()
            throw APIError.unauthenticated
        }
        if let rotated = grant.refreshToken, rotated != refresh {
            Keychain.write(Self.refreshKey, rotated)
            kind = .provider(provider, refresh: rotated)
        }
        access = (grant.accessToken, Date.now.addingTimeInterval(TimeInterval(grant.expiresIn)))
        return grant.accessToken
    }

    var canRefresh: Bool {
        if case .provider = kind { return true }
        return false
    }

    /// Ends the provider's session for this app. Best effort: signing out locally always works.
    func revoke() async {
        guard case .provider(let provider, let refresh) = kind, let endpoint = provider.revocationEndpoint else { return }
        _ = try? await TokenGrant.post(endpoint, [
            "token": refresh,
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
