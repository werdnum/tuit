import AuthenticationServices
import CryptoKit
import Foundation
import Observation
import UIKit

/// Who is signed in, to which server, and the household roster. Sign-in opens
/// /app/authorize in a browser sheet (the person's normal SSO), confirms there, and swaps
/// the one-time code plus PKCE verifier for a personal token kept in the Keychain.
@Observable
final class Session {
    /// The server this build's associated domains cover (Project.swift). Browser sign-in only
    /// works there; any other server needs a pasted token.
    static let defaultServer = Bundle.main.object(forInfoDictionaryKey: "TuitServer") as? String ?? ""
    static let signInHost = URL(string: defaultServer)?.host()
    private static let serverKey = "tuit_server_url"
    private static let tokenKey = "tuit_token"

    var serverURL: String
    private(set) var token: String?
    private(set) var me: Me?
    var signingIn = false
    var error: String?
    /// Bumped whenever the change feed moves, so visible screens reload.
    private(set) var changeTick = 0

    private var authSession: ASWebAuthenticationSession?
    private let presenter = Presenter()
    private var cursor: String?

    init() {
        serverURL = UserDefaults.standard.string(forKey: Self.serverKey) ?? Self.defaultServer
        token = Keychain.read(Self.tokenKey)
        #if DEBUG
        // For simulator runs and screenshots: `simctl launch` with TUIT_SERVER and TUIT_TOKEN.
        let env = ProcessInfo.processInfo.environment
        if let server = env["TUIT_SERVER"], let debugToken = env["TUIT_TOKEN"] {
            serverURL = server
            token = debugToken
        }
        #endif
    }

    var isSignedIn: Bool { token != nil }

    var api: API? {
        guard let token, let base = URL(string: serverURL) else { return nil }
        return API(base: base, token: token)
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
        let verifier = Self.randomURLSafe(32)
        let state = Self.randomURLSafe(16)
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncoded
        var comps = URLComponents(url: base.appending(path: "app/authorize"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "device", value: UIDevice.current.name),
        ]
        authSession?.cancel()
        let session = ASWebAuthenticationSession(
            url: comps.url!,
            // A Universal Link iOS only hands to this app, because the server's
            // apple-app-site-association names it. A tuit:// scheme could be claimed by any app.
            callback: .https(host: host, path: "/.well-known/app-auth-callback")
        ) { [weak self] url, err in
            Task { @MainActor in
                await self?.finishSignIn(base: base, callback: url, error: err, verifier: verifier, state: state)
            }
        }
        session.presentationContextProvider = presenter
        authSession = session
        if !session.start() {
            signingIn = false
            error = "Couldn't open the sign-in page."
        }
    }

    private func finishSignIn(base: URL, callback: URL?, error err: Error?, verifier: String, state: String) async {
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
            var req = URLRequest(url: base.appending(path: "app/token"))
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(["code": code, "code_verifier": verifier])
            let (data, response) = try await URLSession.shared.data(for: req)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                let message = (try? API.decoder.decode(APIErrorBody.self, from: data))?.message
                error = message ?? "Sign-in failed. Try again."
                return
            }
            struct Granted: Decodable { var token: String }
            let granted = try JSONDecoder().decode(Granted.self, from: data)
            use(token: granted.token)
            await refreshMe()
        } catch {
            self.error = "Couldn't reach \(base.host() ?? "the server"): \(error.localizedDescription)"
        }
    }

    /// For a personal token made in Settings → Tokens, e.g. when the server has no browser sign-in.
    func signIn(withToken raw: String) async {
        guard normalizedServer() != nil else {
            error = "That doesn't look like a web address."
            return
        }
        use(token: raw.trimmingCharacters(in: .whitespacesAndNewlines))
        await refreshMe()
        if me == nil { signOutLocally() }
    }

    private func use(token: String) {
        UserDefaults.standard.set(serverURL, forKey: Self.serverKey)
        Keychain.write(Self.tokenKey, token)
        self.token = token
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
        if let token, let base = URL(string: serverURL) {
            var req = URLRequest(url: base.appending(path: "app/signout"))
            req.httpMethod = "POST"
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            _ = try? await URLSession.shared.data(for: req)
        }
        signOutLocally()
    }

    private func signOutLocally() {
        Keychain.delete(Self.tokenKey)
        token = nil
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
            await checkForChanges()
            try? await Task.sleep(for: .seconds(15))
        }
    }

    func checkForChanges() async {
        guard let api else { return }
        do {
            let page: ChangePage = try await api.get("/changes", query: ["after": cursor ?? "latest", "limit": "500"])
            if cursor != nil, !page.events.isEmpty { changeTick += 1 }
            cursor = page.cursor
        } catch {
            handle(error)
        }
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
