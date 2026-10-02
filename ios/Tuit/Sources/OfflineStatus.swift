import SwiftUI

struct OfflineBanner: View {
    @Environment(Session.self) private var session
    var body: some View {
        if let store = session.offlineStore, store.offline || !store.pending.isEmpty || store.storageError != nil {
            VStack(alignment: .leading, spacing: 3) {
                Label(store.offline ? "Offline · showing saved data" : "Changes waiting to sync", systemImage: store.offline ? "wifi.slash" : "arrow.triangle.2.circlepath")
                    .font(.callout.weight(.medium))
                if let date = store.lastSaved, store.offline {
                    Text("Saved data from \(date.formatted(date: .abbreviated, time: .shortened)). Dates and urgency may have changed.").font(.caption)
                }
                if !store.pending.isEmpty {
                    Text("\(store.pending.count) saved on this phone. Review in Settings. Task changes appear after syncing.").font(.caption)
                }
                if let error = store.storageError { Text(error).font(.caption).foregroundStyle(.red) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(.regularMaterial)
        }
    }
}

struct OfflineChangesSection: View {
    @Environment(Session.self) private var session
    @State private var error: String?
    @State private var discard: String?

    var body: some View {
        if let store = session.offlineStore {
            Section("Saved changes") {
                if store.pending.isEmpty { Text("Everything is synced.").foregroundStyle(.secondary) }
                ForEach(store.pending) { item in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(item.label)
                        Text(item.savedAt.formatted()).font(.caption).foregroundStyle(.secondary)
                        if let problem = item.problem {
                            Text(problem).font(.callout).foregroundStyle(.red)
                            Button("Retry saved change") {
                                do { try store.retry(item.id) } catch { self.error = error.localizedDescription }
                                Task { await session.syncNow() }
                            }
                            Text("Review the task before retrying. A conflict needs a new edit using the current task.").font(.caption)
                        } else {
                            Text("Waiting to sync").font(.caption).foregroundStyle(.secondary)
                        }
                        Button("Discard saved change", role: .destructive) { discard = item.id }
                    }
                }
                Button("Sync now") { Task { await session.syncNow() } }.disabled(store.syncing)
                Text("Snooze, pin and Now list controls need a connection.").font(.caption).foregroundStyle(.secondary)
                if let error { Text(error).foregroundStyle(.red) }
            }
            .confirmationDialog("Discard this saved change?", isPresented: Binding(get: { discard != nil }, set: { if !$0 { discard = nil } })) {
                Button("Discard", role: .destructive) {
                    if let discard {
                        do { try store.remove(discard) } catch { self.error = error.localizedDescription }
                    }
                    discard = nil
                }
            } message: { Text("A change whose response was lost may already be on the server. Check the task first.") }
        }
    }
}
