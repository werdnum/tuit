import AuthenticationServices
import CryptoKit
import Foundation
import Observation
import UIKit

/// Who is signed in, to which server, and the household roster. Sign-in is OpenID Connect
/// with the household's identity provider (Keycloak) in a browser sheet: a public client with
/// PKCE whose code comes back on a Universal Link only this app receives. Tuit then sees the
/// provider's access tokens, which the gateway checks before Tuit does.
@Observable
final class Session {
    /// The server this build's associated domains cover (Project.swift). Browser sign-in only
    /// works there; any other server needs a pasted token.
    static let defaultServer = Bundle.main.object(forInfoDictionaryKey: "TuitServer") as? String ?? ""
    static let signInHost = URL(string: defaultServer)?.host()
    static let callbackPath = "/.well-known/app-auth-callback"
    private static let serverKey = "tuit_server_url"

    var serverURL: String
    private(set) var credentials: Credentials?
    private(set) var me: Me?
    var signingIn = false
    var error: String?
    /// Bumped whenever the change feed moves, so visible screens reload.
    private(set) var changeTick = 0

    private var authSession: ASWebAuthenticationSession?
    private let presenter = Presenter()
    private var cursor: String?
    private(set) var offlineStore: OfflineStore?

    init() {
        serverURL = UserDefaults.standard.string(forKey: Self.serverKey) ?? Self.defaultServer
        credentials = Credentials.stored()
        #if DEBUG
        // For simulator runs and screenshots: `simctl launch` with TUIT_SERVER and TUIT_TOKEN.
        let env = ProcessInfo.processInfo.environment
        if let server = env["TUIT_SERVER"], let debugToken = env["TUIT_TOKEN"] {
            serverURL = server
            credentials = .debug(debugToken)
        }
        if env["TUIT_RESET_OFFLINE"] == "1", let credentials {
            try? FileManager.default.removeItem(at: OfflineStore.file(for: credentials.offlineIdentity))
        }
        #endif
        if let credentials { offlineStore = OfflineStore.open(server: serverURL, identity: credentials.offlineIdentity) }
        if let data = offlineStore?.cached("/me") { me = try? API.decoder.decode(Me.self, from: data) }
        if let zone = me?.timezone.flatMap(TimeZone.init(identifier:)) { Household.zone = zone }
    }

    var isSignedIn: Bool { credentials != nil }

    var api: API? {
        guard let credentials, let base = URL(string: serverURL) else { return nil }
        return API(base: base, credentials: credentials, offlineStore: offlineStore)
    }

    func name(of userId: String) -> String {
        me?.household.first { $0.id == userId }?.name ?? userId
    }

    func actorName(_ a: Actor) -> String {
        switch a {
        case .user(let u): u == me?.user?.id ? "you" : name(of: u)
        case .agent(let name): "agent:\(name)"
        case .anyone: "anyone"
        }
    }

    // MARK: Sign-in

    private func normalizedServer() -> URL? {
        var s = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.contains("://") { s = "https://\(s)" }
        while s.hasSuffix("/") { s.removeLast() }
        guard let url = URL(string: s), url.host != nil else { return nil }
        serverURL = s
        return url
    }

    func signIn() {
        guard let base = normalizedServer() else {
            error = "That doesn't look like a web address."
            return
        }
        guard let host = base.host(), host == Self.signInHost else {
            error = "This app can only sign in to \(Self.signInHost ?? "its own server") in the browser. For another server, use a token."
            return
        }
        error = nil
        signingIn = true
        Task { await startSignIn(host: host) }
    }

    private func startSignIn(host: String) async {
        let provider: IdentityProvider
        do {
            provider = try await IdentityProvider.discover()
        } catch {
            self.error = error.localizedDescription
            signingIn = false
            return
        }
        let verifier = Self.randomURLSafe(32)
        let state = Self.randomURLSafe(16)
        let redirect = "https://\(host)\(Self.callbackPath)"
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncoded
        var comps = URLComponents(url: provider.authorizationEndpoint, resolvingAgainstBaseURL: false)!
        comps.queryItems = [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: IdentityProvider.clientId),
            URLQueryItem(name: "redirect_uri", value: redirect),
            // offline_access: a refresh token that outlives the browser session.
            URLQueryItem(name: "scope", value: "openid email offline_access"),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
        ]
        authSession?.cancel()
        let session = ASWebAuthenticationSession(
            url: comps.url!,
            // A Universal Link iOS only hands to this app, because the server's
            // apple-app-site-association names it. A tuit:// scheme could be claimed by any app.
            callback: .https(host: host, path: Self.callbackPath)
        ) { [weak self] url, err in
            Task { @MainActor in
                await self?.finishSignIn(provider, redirect: redirect, callback: url, error: err, verifier: verifier, state: state)
            }
        }
        session.presentationContextProvider = presenter
        authSession = session
        if !session.start() {
            signingIn = false
            error = "Couldn't open the sign-in page."
        }
    }

    private func finishSignIn(
        _ provider: IdentityProvider, redirect: String, callback: URL?, error err: Error?, verifier: String, state: String
    ) async {
        defer { signingIn = false; authSession = nil }
        if let err {
            if (err as? ASWebAuthenticationSessionError)?.code != .canceledLogin {
                error = err.localizedDescription
            }
            return
        }
        guard let callback, let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems,
              items.first(where: { $0.name == "state" })?.value == state
        else {
            error = "Sign-in came back garbled. Try again."
            return
        }
        guard let code = items.first(where: { $0.name == "code" })?.value else {
            if items.first(where: { $0.name == "error" })?.value != "access_denied" {
                error = "Sign-in didn't finish. Try again."
            }
            return
        }
        do {
            let grant = try await TokenGrant.request(provider.tokenEndpoint, [
                "grant_type": "authorization_code",
                "code": code,
                "code_verifier": verifier,
                "redirect_uri": redirect,
                "client_id": IdentityProvider.clientId,
            ])
            guard let credentials = Credentials.signedIn(provider, grant) else {
                error = "The sign-in service didn't allow staying signed in. Try again."
                return
            }
            remember(credentials)
            await refreshMe()
        } catch APIError.unauthenticated {
            error = "That sign-in expired. Try again."
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// For a personal token made in Settings → Tokens, e.g. on a server without app sign-in.
    func signIn(withToken raw: String) async {
        guard normalizedServer() != nil else {
            error = "That doesn't look like a web address."
            return
        }
        remember(.pasted(raw.trimmingCharacters(in: .whitespacesAndNewlines)))
        await refreshMe()
        if me == nil { signOutLocally() }
    }

    private func remember(_ credentials: Credentials) {
        UserDefaults.standard.set(serverURL, forKey: Self.serverKey)
        offlineStore?.clear()
        offlineStore = OfflineStore.open(server: serverURL, identity: credentials.offlineIdentity)
        me = nil
        self.credentials = credentials
        cursor = nil
    }

    func refreshMe() async {
        guard let api else { return }
        do {
            me = try await api.get("/me")
            if let zone = me?.timezone.flatMap(TimeZone.init(identifier:)) { Household.zone = zone }
            if me?.agent != nil {
                error = "That token belongs to an agent. Use a personal token or sign in."
                signOutLocally()
            }
        } catch {
            handle(error)
        }
    }

    func signOut() async {
        let old = credentials
        signOutLocally()
        await old?.revoke()
    }

    private func signOutLocally() {
        offlineStore?.clear()
        offlineStore = nil
        Credentials.clear()
        credentials = nil
        me = nil
        cursor = nil
    }

    /// Screens route errors here so a revoked token lands on the sign-in screen.
    @discardableResult
    func handle(_ err: Error) -> String {
        if case APIError.unauthenticated = err {
            signOutLocally()
            error = APIError.unauthenticated.errorDescription
        }
        return err.localizedDescription
    }

    // MARK: Live updates

    /// Polls the change feed while the app is in the foreground. Personal changes (snooze, pin)
    /// don't appear in the feed, but those come from this app and reload on their own.
    func watchChanges() async {
        while !Task.isCancelled {
            await syncPending()
            await checkForChanges()
            try? await Task.sleep(for: .seconds(15))
        }
    }

    func syncNow() async {
        await syncPending()
        await checkForChanges()
        await refreshMe()
    }

    func syncPending() async {
        guard let api else { return }
        let count = offlineStore?.pending.count ?? 0
        do {
            try await api.sync()
            if offlineStore?.pending.count != count { changeTick += 1 }
        } catch { handle(error) }
    }

    func checkForChanges() async {
        guard let api else { return }
        let wasOffline = offlineStore?.offline == true
        do {
            let page: ChangePage = try await api.get("/changes", query: ["after": cursor ?? "latest", "limit": "500"])
            let moved = cursor == nil || !page.events.isEmpty || wasOffline
            cursor = page.cursor
            if moved {
                changeTick += 1
                await prepareOffline()
            }
        } catch {
            handle(error)
        }
    }

    /// Refresh all visible tasks and their detail/history so browsing and search work on a trip.
    private func prepareOffline() async {
        guard let api else { return }
        do {
            let list: TaskList = try await api.get("/tasks")
            guard offlineStore?.offline == false else { return }
            for task in list.tasks {
                try Task.checkCancellation()
                let _: TaskView = try await api.get("/tasks/\(task.id)")
                if offlineStore?.offline == true { return }
            }
        } catch { handle(error) }
    }

    // MARK: Helpers

    private static func randomURLSafe(_ count: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: count)
        _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        return Data(bytes).base64URLEncoded
    }
}

private final class Presenter: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
}

extension Data {
    var base64URLEncoded: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
