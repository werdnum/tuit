import SwiftUI

@main
struct TuitApp: App {
    @State private var session = Session()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .tint(Color("AccentColor"))
        }
    }
}

struct RootView: View {
    @Environment(Session.self) private var session
    @Environment(\.scenePhase) private var phase
    @State private var tab = "now"
    @State private var nowPath: [String] = {
        #if DEBUG
        // For screenshots: `simctl launch` with TUIT_OPEN=<task id>.
        if let id = ProcessInfo.processInfo.environment["TUIT_OPEN"] { return [id] }
        #endif
        return []
    }()

    var body: some View {
        if session.isSignedIn {
            TabView(selection: $tab) {
                NavigationStack(path: $nowPath) { NowScreen() }
                    .tabItem { Label("Now", systemImage: "sun.max") }
                    .tag("now")
                NavigationStack { TasksScreen() }
                    .tabItem { Label("Tasks", systemImage: "magnifyingglass") }
                    .tag("tasks")
                NavigationStack { SettingsScreen() }
                    .tabItem { Label("Settings", systemImage: "gearshape") }
                    .tag("settings")
            }
            // tuit://tasks/<id> opens a task, e.g. from a notification an agent sent.
            .onOpenURL { url in
                guard url.host() == "tasks", let id = url.pathComponents.dropFirst().first else { return }
                tab = "now"
                nowPath = [id]
            }
            // Live updates only while on screen; returning to the app catches up at once.
            .task(id: phase) {
                guard phase == .active else { return }
                await session.refreshMe()
                await session.watchChanges()
            }
        } else {
            SignInView()
        }
    }
}

struct SignInView: View {
    @Environment(Session.self) private var session
    @State private var pasting = false
    @State private var token = ""

    var body: some View {
        @Bindable var session = session
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Image(systemName: "circle.circle")
                            .font(.system(size: 44))
                            .foregroundStyle(.tint)
                        Text("Tuit").font(.largeTitle.bold())
                        Text("For things you'll do when you get a round tuit.")
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 8)
                    .listRowBackground(Color.clear)
                }
                Section {
                    TextField("tuit.example.com", text: $session.serverURL)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Server")
                }
                Section {
                    Button {
                        session.signIn()
                    } label: {
                        HStack {
                            Text("Sign in")
                            Spacer()
                            if session.signingIn { ProgressView() }
                        }
                    }
                    .disabled(session.serverURL.trimmed.isEmpty || session.signingIn)
                } footer: {
                    Text("You'll sign in with your household account in a browser sheet, then confirm.")
                }
                Section {
                    DisclosureGroup("Use a token instead", isExpanded: $pasting) {
                        SecureField("Personal token from Settings → Tokens", text: $token)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button("Sign in with token") {
                            Task { await session.signIn(withToken: token) }
                        }
                        .disabled(token.trimmed.isEmpty || session.serverURL.trimmed.isEmpty)
                    }
                }
                if let error = session.error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
        }
    }
}

struct SettingsScreen: View {
    @Environment(Session.self) private var session
    @Environment(\.openURL) private var openURL
    @State private var confirming = false

    var body: some View {
        Form {
            Section("Signed in") {
                LabeledContent("As", value: session.me?.user?.name ?? "…")
                LabeledContent("Server", value: URL(string: session.serverURL)?.host() ?? session.serverURL)
            }
            Section {
                Button("Open Tuit on the web") {
                    if let url = URL(string: session.serverURL) { openURL(url) }
                }
                Button("Tokens and connectors") {
                    if let url = URL(string: session.serverURL)?.appending(path: "settings") { openURL(url) }
                }
            } footer: {
                Text("Queues, tokens and agent connectors are managed on the web.")
            }
            Section {
                Button("Sign out", role: .destructive) { confirming = true }
            }
        }
        .navigationTitle("Settings")
        .confirmationDialog("Sign out of Tuit on this phone?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { await session.signOut() } }
        }
    }
}
