import SwiftUI

/// Today's short list, anything urgent, and what's new since the list was made. Finishing an
/// item leaves it ticked in place; nothing slides in to replace it.
struct NowScreen: View {
    @Environment(Session.self) private var session
    @State private var now: NowView?
    @State private var area: String?
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        List {
            Section {
                CaptureField(area: area) { await load() }
            }
            if let now {
                content(now)
            } else if busy {
                HStack { Spacer(); ProgressView(); Spacer() }.listRowBackground(Color.clear)
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(area.map { "Now · #\($0)" } ?? "Now")
        .toolbar { toolbar }
        .refreshable { await load() }
        .errorBanner($error)
        .task { await load() }
        .onChange(of: session.changeTick) { Task { await load() } }
        .onChange(of: area) { Task { await load() } }
        .navigationDestination(for: String.self) { id in TaskDetailScreen(taskId: id) }
    }

    @ViewBuilder
    private func content(_ now: NowView) -> some View {
        if let away = now.away {
            Section {
                Label {
                    Text("Welcome back. Since \(Fmt.ago(away.since)): \(away.expired) expired, \(away.handedToYou) handed to you, \(away.becameDue) came due.")
                } icon: { Image(systemName: "hand.wave") }
                .font(.callout)
            }
        }
        if !now.areas.isEmpty {
            Section {
                AreaChips(areas: now.areas, selected: $area)
            }
            .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0))
            .listRowBackground(Color.clear)
        }
        if !now.urgent.isEmpty {
            Section("Urgent") {
                ForEach(now.urgent) { item in row(item) }
            }
        }
        if let until = now.enoughUntil {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Enough for now").font(.headline)
                    Text("Your list is resting until \(Fmt.when(until)). Urgent things still show.")
                        .font(.callout).foregroundStyle(.secondary)
                    if now.restingCount > 0 {
                        Button("Show my list anyway (\(now.restingCount))") { Task { await enough(false) } }
                    }
                }
                .padding(.vertical, 4)
            }
        } else {
            Section {
                if now.plan.isEmpty {
                    Text(now.urgent.isEmpty ? "Nothing needs you right now." : "Nothing else today.")
                        .foregroundStyle(.secondary)
                }
                ForEach(now.plan) { row in self.row(row.item, done: row.done) }
                if now.moreCount > 0 {
                    Button("Show \(now.moreCount) more") { Task { await more() } }
                }
            } header: {
                Text("Today")
            } footer: {
                if now.waitingCount > 0 {
                    Text("\(now.waitingCount) waiting on something else.")
                }
            }
            if !now.newItems.isEmpty {
                Section("New since this morning") {
                    ForEach(now.newItems) { item in row(item) }
                }
            }
            if !now.also.isEmpty {
                Section("Also in #\(now.area ?? "")") {
                    ForEach(now.also) { item in row(item) }
                }
            }
        }
    }

    private func row(_ item: QueueItem, done: Bool = false) -> some View {
        NavigationLink(value: item.task.id) {
            TaskRow(item: item, done: done)
        }
        .swipeActions(edge: .leading) {
            if !done {
                Button { Task { await act(item) { api in
                    let _: TaskView = try await api.post("/tasks/\(item.task.id)/complete", CompleteBody(expectedRevision: item.task.revision))
                } } } label: { Label("Done", systemImage: "checkmark") }
                .tint(.green)
            }
        }
        .swipeActions(edge: .trailing) {
            Button { Task { await act(item) { api in
                let _: TaskView = try await api.post("/tasks/\(item.task.id)/snooze", SnoozeBody(until: "tomorrow"))
            } } } label: { Label("Tomorrow", systemImage: "moon.zzz") }
            .tint(.indigo)
            Button { Task { await act(item) { api in
                let _: TaskView = try await api.post("/tasks/\(item.task.id)/pin", PinBody(pinned: !item.pinned))
            } } } label: { Label(item.pinned ? "Unpin" : "Pin", systemImage: item.pinned ? "pin.slash" : "pin") }
            .tint(.orange)
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Menu {
                if now?.enoughUntil == nil {
                    Button { Task { await enough(true) } } label: {
                        Label("Enough for now", systemImage: "cup.and.saucer")
                    }
                } else {
                    Button { Task { await enough(false) } } label: {
                        Label("Back to my list", systemImage: "list.bullet")
                    }
                }
                if (now?.moreCount ?? 0) > 0 {
                    Button { Task { await more() } } label: { Label("Show more", systemImage: "plus") }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
        }
    }

    private func load() async {
        guard let api = session.api else { return }
        busy = true
        defer { busy = false }
        do {
            now = try await api.get("/now", query: area.map { ["area": $0] } ?? [:])
        } catch {
            self.error = session.handle(error)
        }
    }

    private func act(_ item: QueueItem, _ fn: (API) async throws -> Void) async {
        guard let api = session.api else { return }
        do {
            try await fn(api)
        } catch {
            self.error = session.handle(error)
        }
        await load()
    }

    private func enough(_ on: Bool) async {
        guard let api = session.api else { return }
        do {
            let _: NowView = try await api.post("/now/enough", EnoughBody(on: on))
        } catch { self.error = session.handle(error) }
        await load()
    }

    private func more() async {
        guard let api = session.api else { return }
        do {
            let _: NowView = try await api.post("/now/more", Empty())
        } catch { self.error = session.handle(error) }
        await load()
    }
}

struct TaskRow: View {
    @Environment(Session.self) private var session
    let item: QueueItem
    var done = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: done ? "checkmark.circle.fill" : icon)
                .foregroundStyle(done ? .green : tint)
                .imageScale(.medium)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    if item.pinned { Image(systemName: "pin.fill").font(.caption).foregroundStyle(.orange) }
                    if item.task.isPrivate { Image(systemName: "lock.fill").font(.caption).foregroundStyle(.secondary) }
                    Text(item.task.title)
                        .strikethrough(done)
                        .foregroundStyle(done ? .secondary : .primary)
                }
                if !item.task.nextAction.isEmpty, !done {
                    Text(item.task.nextAction).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                }
                HStack(spacing: 6) {
                    if let area = item.task.area {
                        Text("#\(area)").font(.caption.weight(.medium)).foregroundStyle(.tint)
                    }
                    if !item.why.isEmpty {
                        Text(item.why).font(.caption).foregroundStyle(item.urgent ? .red : .secondary)
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }

    private var icon: String {
        if item.urgent { return "exclamationmark.circle" }
        if item.task.recurrence != nil { return "arrow.triangle.2.circlepath" }
        if item.task.state == "waiting" { return "hourglass" }
        return "circle"
    }

    private var tint: Color {
        if item.urgent { return .red }
        if item.stale { return .orange }
        return .secondary
    }
}

struct AreaChips: View {
    let areas: [String]
    @Binding var selected: String?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip("All", on: selected == nil) { selected = nil }
                ForEach(areas, id: \.self) { a in
                    chip("#\(a)", on: selected == a) { selected = selected == a ? nil : a }
                }
            }
            .padding(.horizontal, 20)
        }
    }

    private func chip(_ label: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.subheadline.weight(.medium))
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background(on ? AnyShapeStyle(.tint) : AnyShapeStyle(.fill.tertiary), in: Capsule())
                .foregroundStyle(on ? .white : .primary)
        }
        .buttonStyle(.plain)
    }
}

/// Title-only capture. A leading or trailing #word files it under that area; when Now is
/// narrowed to an area, captures go there unless they name another.
struct CaptureField: View {
    @Environment(Session.self) private var session
    var area: String?
    var onAdded: () async -> Void
    @State private var text = ""
    @State private var sending = false
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                TextField("Capture something…", text: $text)
                    .focused($focused)
                    .submitLabel(.done)
                    .onSubmit { Task { await add() } }
                    .disabled(sending)
                if sending {
                    ProgressView()
                } else if !text.isEmpty {
                    Button { Task { await add() } } label: {
                        Image(systemName: "arrow.up.circle.fill").font(.title2)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.tint)
                }
            }
            if let error {
                Text(error).font(.caption).foregroundStyle(.red)
            }
        }
    }

    private func add() async {
        var title = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, let api = session.api else { return }
        if let area, !title.contains("#") { title += " #\(area)" }
        sending = true
        defer { sending = false }
        do {
            let _: TaskView = try await api.post("/tasks", CaptureBody(title: title))
            text = ""
            error = nil
            await onAdded()
        } catch {
            self.error = session.handle(error)
        }
    }
}
