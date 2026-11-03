#if DEBUG
import SwiftUI

/// Isolated fixture for the real feed. Pair --feed-preview with
/// --settings-preview, which disables authentication and production traffic.
struct FeedPreviewHost: View {
    @Environment(AppStore.self) private var store
    @State private var ready = false
    var body: some View {
        Group {
            if ready { HomeFeedView() }
            else { Color.clear.task { seed(); ready = true } }
        }.preferredColorScheme(.dark)
    }
    private func seed() {
        store.profile = EarningsProfile(displayName: "Mikael", interests: [.creative], locationLabel: "Austin, TX")
        let site = TargetSite(id: "upwork", name: "Upwork", startURLString: "https://upwork.com", category: .creative, goalTemplate: "")
        let contra = TargetSite(id: "contra", name: "Contra", startURLString: "https://contra.com", category: .creative, goalTemplate: "")
        store.sites = [site, contra]; store.tasks = []; store.applications = []; store.chatTranscript = []
        store.archivedFeedIDs = []; store.accountStates = [:]; store.lastMessage = nil; store.lastSyncError = nil
        store.notificationPrimerVisible = false; store.isPaused = false; store.hasOnboarded = true
        store.conversationTaskID = nil; store.pendingTaskOpenID = nil; store.visitMarker = .distantPast
        store.proposals = [ProposedSite(siteID: site.id, rationale: "A place for your design and writing", payPattern: "Rates and fees vary by contract", dataShared: "Name, photo and work profile", verification: "Email and identity checks before payouts")]
        store.opportunities = [Opportunity(siteID: "upwork", title: "Brand refresh for a local café", summary: "Refresh the café’s visual identity, menu and social templates.", category: .creative, payLabel: "$450 fixed", estimatedHourly: nil, locationLabel: "Remote", isRemote: true, requiredSkills: ["Brand design"], urlString: "https://example.com", isDemo: false)]
        var review = AgentTaskFactory.profileTask(profile: store.profile, site: contra)
        review.draftedPayload = ["profileHeadline": "Designer & writer", "profileBio": "Thoughtful brand design and clear writing for small businesses."]
        var question = AgentTaskFactory.signupTask(profile: store.profile, site: contra)
        question.status = .needsHuman
        question.help = TaskHelp(kind: .information, message: "Which title feels most like you?", questions: [.init(text: "Professional title", suggestions: ["Designer & writer", "Creative freelancer"])])
        store.tasks = [review, question]
        store.activityEvents = [
            ActivityEvent(kind: .joinedSite, sentence: "Your Contra account is ready.", detail: "Hygge confirmed that you’re signed in.", siteID: "contra"),
            ActivityEvent(kind: .workCompleted, sentence: "You logged $120 for a design project.", detail: "This amount was entered by you.", siteID: "contra", grossAmount: 120)
        ]
    }
}
#endif
