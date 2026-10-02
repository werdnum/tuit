import SwiftUI

/// Shared chrome for the task sheets: Cancel, a primary button, a busy state and errors.
private struct SheetForm<Content: View>: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(Session.self) private var session
    let title: String
    let action: String
    var canSubmit = true
    let submit: (API) async throws -> Void
    let done: () async -> Void
    @ViewBuilder let content: () -> Content
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Form {
            content()
            if let error {
                Section { Text(error).foregroundStyle(.red).font(.callout) }
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                if busy {
                    ProgressView()
                } else {
                    Button(action) { Task { await run() } }.disabled(!canSubmit)
                }
            }
        }
        .interactiveDismissDisabled(busy)
    }

    private func run() async {
        guard let api = session.api else { return }
        busy = true
        defer { busy = false }
        do {
            try await submit(api)
            await done()
            dismiss()
        } catch APIError.queued {
            await done()
            dismiss()
        } catch {
            self.error = session.handle(error)
            // A conflict means the task moved on; show the new state behind the sheet.
            if case APIError.conflict = error { await done() }
        }
    }
}

struct NoteSheet: View {
    let task: TaskItem
    let done: () async -> Void
    @State private var note = ""
    @State private var kind = "note"
    @State private var nextAction: String

    init(task: TaskItem, done: @escaping () async -> Void) {
        self.task = task
        self.done = done
        _nextAction = State(initialValue: task.nextAction)
    }

    var body: some View {
        SheetForm(title: "Add a note", action: "Save", canSubmit: !note.trimmed.isEmpty, submit: { api in
            let _: TaskView = try await api.post("/tasks/\(task.id)/checkpoint", CheckpointBody(
                note: note.trimmed, kind: kind,
                nextAction: nextAction == task.nextAction ? nil : nextAction.trimmed,
                expectedRevision: task.revision
            ))
        }, done: done) {
            Section {
                TextField("What happened, what you found…", text: $note, axis: .vertical)
                    .lineLimit(4...12)
                Picker("Kind", selection: $kind) {
                    Text("Note").tag("note")
                    Text("Research").tag("research")
                    Text("Decision").tag("decision")
                    Text("Attempt").tag("attempt")
                }
            }
            Section("Next action") {
                TextField("The one next step", text: $nextAction, axis: .vertical)
            }
        }
    }
}

struct HandOffSheet: View {
    @Environment(Session.self) private var session
    let task: TaskItem
    let done: () async -> Void
    @State private var to = "anyone"
    @State private var agent = ""
    @State private var nextAction: String
    @State private var note = ""

    init(task: TaskItem, done: @escaping () async -> Void) {
        self.task = task
        self.done = done
        _nextAction = State(initialValue: task.nextAction)
    }

    private var target: String { to == "agent" ? "agent:\(agent.trimmed)" : to }

    var body: some View {
        SheetForm(title: "Hand off", action: "Hand off", canSubmit: to != "agent" || !agent.trimmed.isEmpty, submit: { api in
            let _: TaskView = try await api.post("/tasks/\(task.id)/handoff", HandoffBody(
                to: target,
                note: note.trimmed.isEmpty ? nil : note.trimmed,
                nextAction: nextAction == task.nextAction ? nil : nextAction.trimmed,
                expectedRevision: task.revision
            ))
        }, done: done) {
            Section {
                Picker("To", selection: $to) {
                    ForEach(session.me?.household ?? [], id: \.id) { u in
                        Text(u.id == session.me?.user?.id ? "\(u.name) (me)" : u.name).tag(u.id)
                    }
                    Text("Anyone").tag("anyone")
                    Text("An agent…").tag("agent")
                }
                if to == "agent" {
                    TextField("Agent name, e.g. family-assistant", text: $agent)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                if task.isPrivate, to != session.me?.user?.id, !to.hasPrefix("agent"), to != "agent" {
                    Text("Private tasks can only go to you or your agents. Make it household first.")
                        .font(.caption).foregroundStyle(.orange)
                }
            }
            Section("Next action") {
                TextField("What they should do, e.g. Decide: …", text: $nextAction, axis: .vertical)
            }
            Section("Note") {
                TextField("Optional", text: $note, axis: .vertical).lineLimit(2...6)
            }
        }
    }
}

struct WaitingSheet: View {
    let task: TaskItem
    let done: () async -> Void
    @State private var kind = "reply"
    @State private var waitingFor = ""
    @State private var useDate = true
    @State private var date = Calendar.current.date(byAdding: .day, value: 3, to: .now)!
    @State private var note = ""

    var body: some View {
        SheetForm(title: "Waiting", action: "Save", canSubmit: kind == "until" || !waitingFor.trimmed.isEmpty, submit: { api in
            let what = kind == "reply" ? "Waiting for \(waitingFor.trimmed)" : "Nothing to do until \(Fmt.day(date))"
            let _: TaskView = try await api.post("/tasks/\(task.id)/checkpoint", CheckpointBody(
                note: note.trimmed.isEmpty ? what : note.trimmed,
                state: "waiting",
                waiting: WaitingBody(
                    kind: kind,
                    for: kind == "reply" ? waitingFor.trimmed : nil,
                    followUp: kind == "until" || useDate ? Fmt.day(date) : nil
                ),
                expectedRevision: task.revision
            ))
        }, done: done) {
            Section {
                Picker("Kind", selection: $kind) {
                    Text("A reply").tag("reply")
                    Text("A date").tag("until")
                }
                .pickerStyle(.segmented)
                if kind == "reply" {
                    TextField("Who or what, e.g. the vet", text: $waitingFor)
                    Toggle("Chase it", isOn: $useDate)
                    if useDate {
                        DatePicker("Chase on", selection: $date, in: Date.now..., displayedComponents: .date)
                    }
                } else {
                    DatePicker("Reopen on", selection: $date, in: Date.now..., displayedComponents: .date)
                }
            } footer: {
                Text(kind == "reply"
                     ? "It leaves your list. On the chase date it comes back asking whether to chase."
                     : "It reopens by itself on that day.")
            }
            Section("Note") {
                TextField("Optional", text: $note, axis: .vertical)
            }
        }
    }
}

struct CompleteEarlierSheet: View {
    let task: TaskItem
    let done: () async -> Void
    @State private var date = Calendar.current.date(byAdding: .day, value: -1, to: .now)!
    @State private var note = ""

    var body: some View {
        SheetForm(title: "Done earlier", action: "Done", submit: { api in
            let _: TaskView = try await api.post("/tasks/\(task.id)/complete", CompleteBody(
                at: Fmt.day(date),
                note: note.trimmed.isEmpty ? nil : note.trimmed,
                expectedRevision: task.revision
            ))
        }, done: done) {
            Section {
                DatePicker("When", selection: $date, in: ...Date.now, displayedComponents: .date)
            }
            Section("Note") {
                TextField("Optional", text: $note, axis: .vertical)
            }
        }
    }
}

struct AttachSheet: View {
    let task: TaskItem
    let done: () async -> Void
    @State private var url = ""
    @State private var title = ""

    var body: some View {
        SheetForm(title: "Attach a link", action: "Attach", canSubmit: URL(string: url.trimmed)?.scheme?.hasPrefix("http") == true, submit: { api in
            let _: TaskView = try await api.post("/tasks/\(task.id)/attachments", AttachBody(
                url: url.trimmed,
                title: title.trimmed.isEmpty ? nil : title.trimmed,
                expectedRevision: task.revision
            ))
        }, done: done) {
            Section {
                TextField("https://…", text: $url)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                TextField("What it is (optional)", text: $title)
            } footer: {
                Text("Tuit keeps the link, not the file. Whether someone can open it depends on the file's own sharing.")
            }
        }
        .onAppear {
            if let s = UIPasteboard.general.string, s.hasPrefix("http") { url = s }
        }
    }
}

struct EditTaskSheet: View {
    let task: TaskItem
    let done: () async -> Void
    @State private var title: String
    @State private var brief: String
    @State private var nextAction: String
    @State private var doneMeans: String
    @State private var area: String
    @State private var isPrivate: Bool
    @State private var deadline: String
    @State private var target: String
    @State private var availableFrom: String
    @State private var expires: String

    init(task: TaskItem, done: @escaping () async -> Void) {
        self.task = task
        self.done = done
        _title = State(initialValue: task.title)
        _brief = State(initialValue: task.brief)
        _nextAction = State(initialValue: task.nextAction)
        _doneMeans = State(initialValue: task.doneMeans)
        _area = State(initialValue: task.area ?? "")
        _isPrivate = State(initialValue: task.isPrivate)
        _deadline = State(initialValue: Fmt.input(task.deadline))
        _target = State(initialValue: Fmt.input(task.target))
        _availableFrom = State(initialValue: Fmt.input(task.availableFrom))
        _expires = State(initialValue: Fmt.input(task.expires))
    }

    var body: some View {
        SheetForm(title: "Edit", action: "Save", canSubmit: !title.trimmed.isEmpty, submit: { api in
            let _: TaskView = try await api.patch("/tasks/\(task.id)", changes)
        }, done: done) {
            Section("Outcome") {
                TextField("Title", text: $title, axis: .vertical)
            }
            Section {
                TextField("Where things stand", text: $brief, axis: .vertical).lineLimit(3...14)
            } header: { Text("Brief") } footer: { Text("Markdown. Keep it to a few lines.") }
            Section("Next action") {
                TextField("The one next step", text: $nextAction, axis: .vertical)
            }
            Section("Done means") {
                TextField("Optional", text: $doneMeans, axis: .vertical)
            }
            Section {
                TextField("Area, e.g. home", text: $area)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Toggle("Private", isOn: $isPrivate)
            }
            Section {
                MomentField(label: "Deadline", text: $deadline)
                MomentField(label: "Aiming for", text: $target)
                MomentField(label: "Available from", text: $availableFrom)
                MomentField(label: "Expires", text: $expires)
            } header: {
                Text("When")
            } footer: {
                Text("Type a date or time the way you'd say it: \"fri\", \"tomorrow 9am\", \"2026-11-03\". Clear a field to remove it.")
            }
        }
    }

    private var changes: EditBody {
        func diff(_ new: String, _ old: String) -> String? { new == old ? nil : new }
        return EditBody(
            title: diff(title.trimmed, task.title),
            brief: diff(brief, task.brief),
            nextAction: diff(nextAction.trimmed, task.nextAction),
            doneMeans: diff(doneMeans.trimmed, task.doneMeans),
            visibility: isPrivate == task.isPrivate ? nil : (isPrivate ? "private" : "household"),
            area: diff(area.trimmed, task.area ?? ""),
            target: diff(target.trimmed, Fmt.input(task.target)),
            deadline: diff(deadline.trimmed, Fmt.input(task.deadline)),
            availableFrom: diff(availableFrom.trimmed, Fmt.input(task.availableFrom)),
            expires: diff(expires.trimmed, Fmt.input(task.expires)),
            expectedRevision: task.revision
        )
    }
}

private struct MomentField: View {
    let label: String
    @Binding var text: String

    var body: some View {
        LabeledContent(label) {
            TextField("none", text: $text)
                .multilineTextAlignment(.trailing)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
    }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
