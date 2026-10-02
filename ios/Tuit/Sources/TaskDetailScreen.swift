import SwiftUI

/// One task: the outcome, where things stand, whose turn it is, and its history. Every
/// change sends the revision it was shown at, so a concurrent edit surfaces as a conflict
/// instead of being overwritten.
struct TaskDetailScreen: View {
    @Environment(Session.self) private var session
    @Environment(\.openURL) private var openURL
    let taskId: String
    @State private var view: TaskView?
    @State private var error: String?
    @State private var sheet: Sheet?
    @State private var confirmClose: String?

    enum Sheet: String, Identifiable {
        case note, handOff, waiting, complete, edit, attach
        var id: String { rawValue }
    }

    var body: some View {
        Group {
            if let view {
                content(view)
            } else if let error {
                ContentUnavailableView("Not saved on this phone", systemImage: "wifi.slash", description: Text(error))
            } else {
                ProgressView()
            }
        }
        .navigationTitle(view?.task.title ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .top) { OfflineBanner() }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                if let task = view?.task { TaskShareButton(task: task) }
            }
        }
        .errorBanner($error)
        .task { await load() }
        .refreshable { await load() }
        .onChange(of: session.changeTick) { Task { await load() } }
        .sheet(item: $sheet) { which in
            if let task = view?.task {
                NavigationStack { sheetView(which, task) }
                    .presentationDetents(which == .edit ? [.large] : [.medium, .large])
            }
        }
        .confirmationDialog(
            confirmClose == "expired" ? "No longer relevant?" : "Shelve it?",
            isPresented: Binding(get: { confirmClose != nil }, set: { if !$0 { confirmClose = nil } }),
            titleVisibility: .visible
        ) {
            if let state = confirmClose {
                Button(state == "expired" ? "No longer relevant" : "Shelve") {
                    Task { await mutate { api, t in try await api.post("/tasks/\(t.id)/close", CloseBody(state: state, expectedRevision: t.revision)) } }
                }
            }
        } message: {
            Text(confirmClose == "expired"
                 ? "It closes without being done. Its notes are kept and you can still find it."
                 : "It goes cold but stays searchable. Reopen it any time.")
        }
    }

    @ViewBuilder
    private func content(_ v: TaskView) -> some View {
        let t = v.task
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(t.title).font(.title2.weight(.semibold))
                    HStack(spacing: 8) {
                        if let area = t.area { Text("#\(area)").foregroundStyle(.tint) }
                        if t.isPrivate { Label("Private", systemImage: "lock.fill").labelStyle(.titleAndIcon) }
                        if v.status.pinned { Label("Pinned", systemImage: "pin.fill").foregroundStyle(.orange) }
                    }
                    .font(.caption.weight(.medium))
                    if let urgent = v.status.urgent {
                        Label(urgent, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(.callout)
                    } else if !v.status.label.isEmpty {
                        Text(v.status.label).font(.callout).foregroundStyle(.secondary)
                    }
                    if t.isClosed {
                        Text("\(t.state.capitalized)\(t.closeReason.isEmpty ? "" : ": \(t.closeReason)")")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    if let held = v.status.held, !t.isClosed, held != "waiting" {
                        Text(held.prefix(1).uppercased() + held.dropFirst()).font(.caption).foregroundStyle(.secondary)
                    }
                    if let snoozed = v.status.snoozedUntil {
                        Text("Snoozed until \(Fmt.when(snoozed))").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
            }

            Section("Next") {
                LabeledContent("Whose turn", value: session.actorName(t.nextActor).capitalizedFirst)
                if !t.nextAction.isEmpty {
                    Text(t.nextAction)
                }
                if let w = t.waiting {
                    LabeledContent("Waiting", value: waitingText(w))
                }
                if !t.doneMeans.isEmpty {
                    LabeledContent("Done means", value: t.doneMeans)
                }
            }

            if !t.brief.isEmpty {
                Section("Brief") {
                    Text(Fmt.markdown(t.brief)).textSelection(.enabled)
                }
            }

            dates(t)

            if !t.attachments.isEmpty || !t.isClosed {
                Section("Files") {
                    ForEach(t.attachments) { a in
                        Button {
                            if let url = URL(string: a.url) { openURL(url) }
                        } label: {
                            Label(a.title.isEmpty ? a.url : a.title, systemImage: "paperclip")
                        }
                        .swipeActions {
                            Button(role: .destructive) {
                                Task { await mutate { api, t in try await api.delete("/tasks/\(t.id)/attachments/\(a.id)", RevisionBody(expectedRevision: t.revision)) } }
                            } label: { Label("Remove", systemImage: "trash") }
                        }
                    }
                    if !t.isClosed {
                        Button { sheet = .attach } label: { Label("Attach a link", systemImage: "link.badge.plus") }
                    }
                }
            }

            actions(v)

            if let activity = v.activity, !activity.isEmpty {
                Section("History") {
                    ForEach(activity.reversed()) { entry in ActivityRow(entry: entry) }
                }
            }

            Section {
                LabeledContent("Owner", value: session.name(of: t.owner))
                LabeledContent("Created", value: Fmt.ago(t.createdAt))
            }
            .font(.footnote)
        }
        .listStyle(.insetGrouped)
    }

    @ViewBuilder
    private func dates(_ t: TaskItem) -> some View {
        let rows: [(String, Moment?)] = [
            ("Deadline", t.deadline), ("Aiming for", t.target),
            ("Available from", t.availableFrom), ("Expires", t.expires),
        ]
        let present = rows.filter { $0.1 != nil }
        if !present.isEmpty || t.recurrence != nil {
            Section("When") {
                ForEach(present, id: \.0) { row in
                    LabeledContent(row.0, value: Fmt.moment(row.1!))
                }
                if let r = t.recurrence {
                    LabeledContent(
                        r.mode == "since_done" ? "Time since done" : "Routine",
                        value: "every \(r.everyDays) days"
                    )
                    if let last = t.lastDoneAt {
                        LabeledContent("Last done", value: Fmt.ago(last))
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func actions(_ v: TaskView) -> some View {
        let t = v.task
        if t.isClosed {
            Section {
                Button { Task { await mutate { api, t in try await api.post("/tasks/\(t.id)/reopen", RevisionBody(expectedRevision: t.revision)) } } } label: {
                    Label("Reopen", systemImage: "arrow.uturn.backward")
                }
            }
        } else {
            Section {
                Button { Task { await mutate { api, t in try await api.post("/tasks/\(t.id)/complete", CompleteBody(expectedRevision: t.revision)) } } } label: {
                    Label(t.recurrence == nil ? "Done" : "Did it", systemImage: "checkmark.circle")
                }
                Button { sheet = .complete } label: { Label("Done earlier…", systemImage: "clock.arrow.circlepath") }
                if t.recurrence != nil {
                    Button { Task { await mutate { api, t in try await api.post("/tasks/\(t.id)/skip", RevisionBody(expectedRevision: t.revision)) } } } label: {
                        Label("Skip this time", systemImage: "forward")
                    }
                }
                Button { sheet = .note } label: { Label("Add a note", systemImage: "square.and.pencil") }
                Button { sheet = .handOff } label: { Label("Hand off…", systemImage: "arrow.right.circle") }
                if t.state == "waiting" {
                    Button { Task { await mutate { api, t in try await api.post("/tasks/\(t.id)/checkpoint", CheckpointBody(note: "No longer waiting", state: "open", expectedRevision: t.revision)) } } } label: {
                        Label("Stop waiting", systemImage: "hourglass.bottomhalf.filled")
                    }
                } else {
                    Button { sheet = .waiting } label: { Label("Waiting for…", systemImage: "hourglass") }
                }
                snoozeMenu(v)
                Button { Task { await mutate { api, t in try await api.post("/tasks/\(t.id)/pin", PinBody(pinned: !v.status.pinned)) } } } label: {
                    Label(v.status.pinned ? "Unpin" : "Pin to the top", systemImage: v.status.pinned ? "pin.slash" : "pin")
                }
                .disabled(session.offlineStore?.offline == true)
                Button { sheet = .edit } label: { Label("Edit", systemImage: "pencil") }
            }
            Section {
                Button { confirmClose = "expired" } label: { Label("No longer relevant", systemImage: "xmark.circle") }
                Button { confirmClose = "shelved" } label: { Label("Shelve", systemImage: "archivebox") }
            }
            .tint(.secondary)
        }
    }

    private func snoozeMenu(_ v: TaskView) -> some View {
        Menu {
            ForEach([("Tomorrow", "tomorrow"), ("This weekend", "sat"), ("Next week", "mon"), ("In a month", Fmt.day(.now.addingTimeInterval(30 * 86400)))], id: \.1) { label, when in
                Button(label) { Task { await snooze(when) } }
            }
            if v.status.snoozedUntil != nil {
                Button("Unsnooze") { Task { await snooze(nil) } }
            }
        } label: {
            Label("Snooze", systemImage: "moon.zzz")
        }
        .disabled(session.offlineStore?.offline == true)
    }

    @ViewBuilder
    private func sheetView(_ which: Sheet, _ t: TaskItem) -> some View {
        switch which {
        case .note: NoteSheet(task: t) { await load() }
        case .handOff: HandOffSheet(task: t) { await load() }
        case .waiting: WaitingSheet(task: t) { await load() }
        case .complete: CompleteEarlierSheet(task: t) { await load() }
        case .edit: EditTaskSheet(task: t) { await load() }
        case .attach: AttachSheet(task: t) { await load() }
        }
    }

    private func waitingText(_ w: Waiting) -> String {
        var s: String
        switch w.kind {
        case "until": s = "until \(w.followUp.map(Fmt.moment) ?? "later")"
        case "task": s = "on another task"
        default: s = w.for.isEmpty ? "on a reply" : "for \(w.for)"
        }
        s += " · since \(Fmt.ago(w.since))"
        if w.kind == "reply", let f = w.followUp { s += " · chase \(Fmt.moment(f))" }
        return s
    }

    private func snooze(_ until: String?) async {
        await mutate { api, t in try await api.post("/tasks/\(t.id)/snooze", SnoozeBody(until: until)) }
    }

    private func load() async {
        guard let api = session.api else { return }
        if let data = session.offlineStore?.cached("/tasks/\(taskId)") {
            view = try? API.decoder.decode(TaskView.self, from: data)
        }
        do {
            view = try await api.get("/tasks/\(taskId)")
        } catch {
            self.error = session.handle(error)
        }
    }

    private func mutate(_ fn: (API, TaskItem) async throws -> TaskView) async {
        guard let api = session.api, let task = view?.task else { return }
        do {
            _ = try await fn(api, task)
            error = nil
        } catch APIError.queued {
            error = nil
        } catch {
            self.error = session.handle(error)
        }
        await load()
    }
}

struct ActivityRow: View {
    @Environment(Session.self) private var session
    let entry: ActivityEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if entry.author.agent != nil {
                    Image(systemName: "sparkles").foregroundStyle(.purple)
                }
                Text(author).font(.caption.weight(.semibold))
                Text(kindLabel).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text(Fmt.ago(entry.happenedAt)).font(.caption).foregroundStyle(.secondary)
            }
            if !entry.body.isEmpty {
                Text(Fmt.markdown(entry.body)).font(.callout).textSelection(.enabled)
            }
        }
        .padding(.vertical, 2)
    }

    private var author: String {
        let who = entry.author.user.map(session.name(of:)) ?? "Tuit"
        if let agent = entry.author.agent { return "agent:\(agent)\(entry.author.user != nil ? " for \(who)" : "")" }
        return who
    }

    private var kindLabel: String {
        switch entry.kind {
        case "note": ""
        case "state_change": "changed state"
        case "handoff": "handed off"
        case "edit": "edited"
        default: entry.kind.replacingOccurrences(of: "_", with: " ")
        }
    }
}

extension String {
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}
