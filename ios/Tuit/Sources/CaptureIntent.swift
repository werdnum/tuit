import AppIntents
import Foundation

/// "Add to Tuit" for Siri, Shortcuts, the Action button and Spotlight. Same capture as the
/// app: a title, with #area at either end filing it.
struct CaptureIntent: AppIntent {
    static let title: LocalizedStringResource = "Add to Tuit"
    static let description = IntentDescription("Capture something to do when you get a round tuit.")

    @Parameter(title: "What", requestValueDialog: "What do you want to capture?")
    var what: String

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let api = Session().api else {
            throw IntentFailure("Open Tuit and sign in first.")
        }
        let view: TaskView = try await api.post("/tasks", CaptureBody(title: what))
        return .result(dialog: "Added “\(view.task.title)”.")
    }
}

struct IntentFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

struct TuitShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: CaptureIntent(),
            phrases: ["Add to \(.applicationName)", "Capture in \(.applicationName)"],
            shortTitle: "Add to Tuit",
            systemImageName: "plus.circle"
        )
    }
}
