import SwiftUI

/// Everything that exists, not just what deserves attention: search, or browse by state.
struct TasksScreen: View {
    @Environment(Session.self) private var session
    @State private var query = ""
    @State private var filter = "active"
    @State private var tasks: [TaskItem] = []
    @State private var error: String?
    @State private var loaded = false

    private let filters = [
        ("active", "Active"), ("waiting", "Waiting"), ("done", "Done"),
        ("expired", "Expired"), ("shelved", "Shelved"),
    ]

    var body: some View {
        List {
            Section {
                Picker("Show", selection: $filter) {
                    ForEach(filters, id: \.0) { Text($0.1).tag($0.0) }
                }
                .pickerStyle(.menu)
            }
            Section {
                if loaded, tasks.isEmpty {
                    Text(query.isEmpty ? "Nothing here." : "No matches.").foregroundStyle(.secondary)
                }
                ForEach(tasks) { t in
                    NavigationLink(value: t.id) { TaskListRow(task: t) }
                        .contextMenu { TaskShareButton(task: t) }
                }
            }
        }
        .navigationTitle("Tasks")
        .safeAreaInset(edge: .top) { OfflineBanner() }
        .searchable(text: $query, prompt: "Title, brief, notes…")
        .task(id: "\(filter)|\(query)") {
            // Debounce typing; a newer keystroke cancels this task.
            if !query.isEmpty { try? await Task.sleep(for: .milliseconds(300)) }
            guard !Task.isCancelled else { return }
            await load()
        }
        .refreshable { await load() }
        .onChange(of: session.changeTick) { Task { await load() } }
        .errorBanner($error)
        .navigationDestination(for: String.self) { id in TaskDetailScreen(taskId: id) }
    }

    private func load() async {
        guard let api = session.api else { return }
        var q = ["state": filter]
        if !query.trimmed.isEmpty { q["q"] = query.trimmed }
        if let data = session.offlineStore?.cached("/tasks", query: q),
           let list = try? API.decoder.decode(TaskList.self, from: data) {
            tasks = list.tasks
            loaded = true
        }
        do {
            let list: TaskList = try await api.get("/tasks", query: q)
            // Search spans every state; narrow it to the chosen one here.
            tasks = list.tasks.filter { t in
                switch filter {
                case "active": !t.isClosed
                default: t.state == filter
                }
            }
            loaded = true
        } catch {
            self.error = session.handle(error)
        }
    }
}

struct TaskListRow: View {
    @Environment(Session.self) private var session
    let task: TaskItem

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                if task.isPrivate { Image(systemName: "lock.fill").font(.caption).foregroundStyle(.secondary) }
                Text(task.title).foregroundStyle(task.isClosed ? .secondary : .primary)
            }
            HStack(spacing: 6) {
                if let area = task.area { Text("#\(area)").foregroundStyle(.tint) }
                Text(detail).foregroundStyle(.secondary)
            }
            .font(.caption)
        }
    }

    private var detail: String {
        if task.isClosed { return "\(task.state) \(task.closedAt.map(Fmt.ago) ?? "")" }
        if let w = task.waiting { return w.for.isEmpty ? "waiting" : "waiting for \(w.for)" }
        return "\(session.actorName(task.nextActor).capitalizedFirst)'s turn"
    }
}
