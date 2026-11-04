#if DEBUG
import SwiftUI

/// Isolated fixture for the real feed. Pair --feed-preview with
/// --settings-preview, which disables authentication and production traffic.
struct FeedPreviewHost: View {
    @Environment(AppStore.self) private var store
    @State private var ready = false
    var body: some View {
        Group {
            if ready { HomeFeedView().task { await renderCatalog() }.task { await simulateArrivals() } }
            else { Color.clear.task { seed(); ready = true } }
        }.preferredColorScheme(.dark)
    }
    @MainActor private func simulateArrivals() async {
        guard ProcessInfo.processInfo.arguments.contains("--feed-arrivals-preview") else { return }
        // Isolated, repeatable incoming-data check: leave time to scroll away.
        do { try await Task.sleep(for: .seconds(30)) } catch { return }
        store.opportunities.insert(Opportunity(siteID: "contra", title: "Illustrations for a local bakery", summary: "Create a small set of warm illustrations for the bakery’s packaging.", category: .creative, payLabel: "$600 fixed", estimatedHourly: nil, locationLabel: "Remote", isRemote: true, requiredSkills: ["Illustration"], urlString: "https://example.com/bakery", isDemo: false), at: 0)
        do { try await Task.sleep(for: .seconds(15)) } catch { return }
        if let index = store.tasks.firstIndex(where: { $0.browserSessionID != nil }) {
            let id = store.tasks[index].id
            store.tasks[index].status = .succeeded
            store.tasks[index].browserSessionID = nil
            store.activityEvents.append(ActivityEvent(id: id, kind: .profileLive, sentence: "Your Workroom profile is live.", siteID: "workroom"))
        }
    }
    @MainActor private func renderCatalog() async {
        guard ProcessInfo.processInfo.arguments.contains("--feed-catalog") else { return }
        try? await Task.sleep(for: .seconds(3))
        let board = FeedCatalogBoard(liveTask: store.tasks.first { $0.browserSessionID != nil })
            .environment(store).environment(\.colorScheme, .dark)
        let renderer = ImageRenderer(content: board)
        renderer.scale = 1
        if let data = renderer.uiImage?.pngData(),
           let folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
            try? data.write(to: folder.appendingPathComponent("feed-object-overview.png"))
        }
    }
    private func seed() {
        store.profile = EarningsProfile(displayName: "Mikael", interests: [.creative], locationLabel: "Austin, TX")
        let site = TargetSite(id: "upwork", name: "Upwork", startURLString: "https://upwork.com", category: .creative, goalTemplate: "")
        let contra = TargetSite(id: "contra", name: "Contra", startURLString: "https://contra.com", category: .creative, goalTemplate: "")
        store.sites = [site, contra]; store.tasks = []; store.applications = []; store.chatTranscript = []
        store.archivedFeedIDs = []; store.accountStates = [:]; store.lastMessage = nil; store.lastSyncError = nil
        store.notificationPrimerVisible = false; store.isPaused = false; store.hasOnboarded = true
        store.conversationTaskID = nil; store.pendingTaskOpenID = nil; store.visitMarker = .distantPast
        store.proposals = [ProposedSite(siteID: site.id, rationale: "A job site for your design and writing", payPattern: "Rates and fees vary by contract", dataShared: "Name, photo and work profile", verification: "Email and identity checks before payouts")]
        store.opportunities = [Opportunity(siteID: "upwork", title: "Brand refresh for a local café", summary: "Refresh the café’s visual identity, menu and social templates.", category: .creative, payLabel: "$450 fixed", estimatedHourly: nil, locationLabel: "Remote", isRemote: true, requiredSkills: ["Brand design"], urlString: "https://example.com", isDemo: false)]
        var review = AgentTaskFactory.profileTask(profile: store.profile, site: contra)
        review.draftedPayload = ["profileHeadline": "Designer & writer", "profileBio": "Thoughtful brand design and clear writing for small businesses."]
        var question = AgentTaskFactory.signupTask(profile: store.profile, site: contra)
        question.status = .needsHuman
        question.help = TaskHelp(kind: .information, message: "Which title feels most like you?", questions: [.init(text: "Professional title", suggestions: ["Designer & writer", "Creative freelancer"])])
        store.tasks = [review, question]
        if ProcessInfo.processInfo.arguments.contains("--browser-preview") {
            let workroom = TargetSite(id: "workroom", name: "Workroom", startURLString: "https://workroom.example", category: .creative, goalTemplate: "")
            store.sites.append(workroom)
            var live = AgentTaskFactory.profileTask(profile: store.profile, site: workroom)
            live.id = UUID(uuidString: "00000000-0000-4000-8000-000000000001")!
            live.status = .running; live.browserSessionID = "preview"; live.backendTaskID = "preview-task"
            store.tasks.append(live)
        }
        store.activityEvents = [
            ActivityEvent(kind: .joinedSite, sentence: "Your Contra account is ready.", detail: "Hygge confirmed that you’re signed in.", siteID: "contra"),
            ActivityEvent(kind: .workCompleted, sentence: "You logged $120 for a design project.", detail: "This amount was entered by you.", siteID: "contra", grossAmount: 120)
        ]
    }
}
#endif
