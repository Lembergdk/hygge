#if DEBUG
import SwiftUI

/// Opt-in real-stream QA against scripts/browser-preview.mts on loopback only.
struct BrowserPreviewHost: View {
    @Environment(AppStore.self) private var store
    @State private var ready = false
    @AppStorage("browserPreviewScreen") private var screen = "feed"
    private let taskID = UUID(uuidString: "00000000-0000-4000-8000-000000000001")!
    var body: some View {
        Group {
            if !ready { Color.clear.task { seed(); ready = true } }
            else if screen == "browser" { CloudBrowserView(urlString: "https://workroom.example", existingSessionID: "preview", taskID: taskID) }
            else if screen == "chat" { ConversationView() }
            else { HomeFeedView() }
        }.preferredColorScheme(.dark)
    }
    private func seed() {
        store.profile = EarningsProfile(displayName: "Mikael", interests: [.creative], locationLabel: "Austin, TX")
        let site = TargetSite(id: "workroom", name: "Workroom", startURLString: "https://workroom.example", category: .creative, goalTemplate: "")
        store.sites = [site]; store.proposals = []; store.opportunities = []; store.applications = []; store.activityEvents = []; store.chatTranscript = []
        store.notificationPrimerVisible = false; store.isPaused = false; store.hasOnboarded = true
        var task = AgentTaskFactory.signupTask(profile: store.profile, site: site)
        task.id = taskID; task.browserSessionID = "preview"; task.backendTaskID = "preview-task"
        task.status = screen == "chat" ? .needsHuman : .running
        if screen == "chat" {
            task.help = TaskHelp(kind: .information, message: "Which title feels most like you?", questions: [.init(text: "Professional title", suggestions: ["Brand designer & writer", "Creative freelancer"])])
        }
        store.tasks = [task]
        if screen == "chat" { store.surfaceTaskHelp(taskID: taskID) }
    }
}
#endif
