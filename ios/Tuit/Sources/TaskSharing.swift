import SwiftUI

/// Share the browser URL so the link works even without the iOS app installed.
/// Access still follows the task's existing visibility rules.
enum TaskSharing {
    static func url(server: String, taskID: String) -> URL? {
        guard var parts = URLComponents(string: server),
              parts.scheme == "https" || parts.scheme == "http",
              let host = parts.host, !host.isEmpty else { return nil }
        parts.user = nil
        parts.password = nil
        parts.query = nil
        parts.fragment = nil
        return parts.url?.appending(component: "tasks").appending(component: taskID)
    }
}

struct TaskShareButton: View {
    @Environment(Session.self) private var session
    let task: TaskItem

    var body: some View {
        if let url = TaskSharing.url(server: session.serverURL, taskID: task.id) {
            ShareLink(item: url, preview: SharePreview(task.title)) {
                Label("Share task", systemImage: "square.and.arrow.up")
            }
        }
    }
}
