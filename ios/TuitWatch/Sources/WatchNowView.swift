import SwiftUI

struct WatchNowView: View {
    @Environment(WatchSessionManager.self) private var store

    private var snapshot: WidgetNowSnapshot { store.snapshot }

    var body: some View {
        NavigationStack {
            List {
                if !snapshot.signedIn {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("Sign in on iPhone", systemImage: "iphone")
                            .font(.headline)
                        Text("Open Tuit on your iPhone to sign in and sync your Now list.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 6)
                } else if let now = snapshot.now {
                    if !now.urgent.isEmpty {
                        Section("Urgent") {
                            ForEach(now.urgent) { item in
                                taskLink(item, done: false)
                            }
                        }
                    }

                    if let until = now.enoughUntil {
                        Section {
                            VStack(alignment: .leading, spacing: 4) {
                                Label("Enough for now", systemImage: "cup.and.saucer.fill")
                                    .font(.headline)
                                Text("Resting until \(Fmt.shortTime(until)).")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 4)
                        }
                    } else {
                        let nothing = now.plan.isEmpty && now.urgent.isEmpty && now.newItems.isEmpty && now.also.isEmpty
                        if nothing {
                            Section {
                                VStack(alignment: .leading, spacing: 4) {
                                    Label("All clear", systemImage: "checkmark.circle.fill")
                                        .font(.headline)
                                        .foregroundStyle(Color("AccentColor"))
                                    Text(now.waitingCount > 0 ? "\(now.waitingCount) waiting on something else." : "Nothing needs you right now.")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                .padding(.vertical, 4)
                            }
                        } else {
                            if !now.plan.isEmpty {
                                Section("Today") {
                                    ForEach(now.plan) { row in
                                        taskLink(row.item, done: row.done)
                                    }
                                }
                            }
                            if !now.newItems.isEmpty {
                                Section("New") {
                                    ForEach(now.newItems) { item in
                                        taskLink(item, done: false)
                                    }
                                }
                            }
                            if !now.also.isEmpty {
                                Section(now.plan.isEmpty && now.newItems.isEmpty ? "Everything" : "Also") {
                                    ForEach(now.also) { item in
                                        taskLink(item, done: false)
                                    }
                                    if now.moreCount > 0 {
                                        Text("+\(now.moreCount) more on iPhone")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }

                    Section {
                        if let error = store.error {
                            Text(error)
                                .font(.caption2)
                                .foregroundStyle(.red)
                        }
                        Button {
                            Task { await store.refreshFromPhone() }
                        } label: {
                            HStack {
                                Label("Refresh", systemImage: "arrow.clockwise")
                                Spacer()
                                if store.isRefreshing {
                                    ProgressView()
                                }
                            }
                        }
                        .disabled(store.isRefreshing || !store.isReachable)
                        Text("Updated \(snapshot.savedAt.formatted(date: .omitted, time: .shortened))")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("Syncing…", systemImage: "arrow.triangle.2.circlepath")
                            .font(.headline)
                        Text("Open Tuit on your iPhone to send your Now list.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 6)
                }
            }
            .navigationTitle("Now")
            .task {
                await store.refreshFromPhone()
            }
        }
    }

    private func taskLink(_ item: QueueItem, done: Bool) -> some View {
        NavigationLink {
            WatchTaskDetailView(item: item, done: done)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: icon(for: item, done: done))
                    .font(.caption)
                    .foregroundStyle(tint(for: item, done: done))
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.task.title)
                        .font(.footnote.weight(item.urgent ? .semibold : .regular))
                        .strikethrough(done)
                        .foregroundStyle(done ? .secondary : .primary)
                        .lineLimit(2)
                    if !item.why.isEmpty && !done {
                        Text(item.why)
                            .font(.caption2)
                            .foregroundStyle(item.urgent ? .red : .secondary)
                            .lineLimit(1)
                    } else if let area = item.task.area, !done {
                        Text("#\(area)")
                            .font(.caption2)
                            .foregroundStyle(.tint)
                    }
                }
            }
        }
    }

    private func icon(for item: QueueItem, done: Bool) -> String {
        if done { return "checkmark.circle.fill" }
        if item.urgent { return "exclamationmark.circle.fill" }
        if item.task.recurrence != nil { return "arrow.triangle.2.circlepath" }
        if item.task.state == "waiting" { return "hourglass" }
        return "circle"
    }

    private func tint(for item: QueueItem, done: Bool) -> Color {
        if done { return .green }
        if item.urgent { return .red }
        if item.stale { return .orange }
        return .secondary
    }
}

private struct WatchTaskDetailView: View {
    @Environment(WatchSessionManager.self) private var store
    @Environment(\.dismiss) private var dismiss
    let item: QueueItem
    let done: Bool
    @State private var completing = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text(item.task.title)
                    .font(.headline)

                HStack(spacing: 6) {
                    if let area = item.task.area {
                        Text("#\(area)")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.tint)
                    }
                    if item.pinned {
                        Label("Pinned", systemImage: "pin.fill")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                    }
                }

                if !item.why.isEmpty {
                    Text(item.why)
                        .font(.caption)
                        .foregroundStyle(item.urgent ? .red : .secondary)
                }

                if !item.task.nextAction.isEmpty {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("NEXT")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Text(item.task.nextAction)
                            .font(.footnote)
                    }
                }

                if !item.task.brief.isEmpty {
                    Text(Fmt.markdown(item.task.brief))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if !done && item.task.openPartCount == 0 && !item.task.isClosed {
                    Button {
                        Task {
                            completing = true
                            let ok = await store.completeTask(id: item.task.id, expectedRevision: item.task.revision)
                            completing = false
                            if ok { dismiss() }
                        }
                    } label: {
                        HStack {
                            Spacer()
                            if completing {
                                ProgressView()
                            } else {
                                Label("Done", systemImage: "checkmark")
                            }
                            Spacer()
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.green)
                    .disabled(completing || !store.isReachable)
                    .padding(.top, 4)
                }

                if let error = store.error {
                    Text(error)
                        .font(.caption2)
                        .foregroundStyle(.red)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 4)
        }
        .navigationTitle("Task")
    }
}
