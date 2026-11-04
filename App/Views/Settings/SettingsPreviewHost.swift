#if DEBUG
import SwiftUI

/// Opt-in, isolated local QA. Never seeds or signs in a production account.
/// Launch with --settings-preview and --settings-populated on a fresh simulator.
struct SettingsPreviewHost: View {
    @Environment(AppStore.self) private var store
    @State private var presented = true
    @AppStorage("settingsPreviewScreen") private var screen = "main"
    var body: some View {
        if ProcessInfo.processInfo.arguments.contains("--plan-preview") { PlanPreviewHost() }
        else if ProcessInfo.processInfo.arguments.contains("--feed-preview") { FeedPreviewHost() }
        else if ProcessInfo.processInfo.arguments.contains("--browser-preview") { BrowserPreviewHost() }
        else if screen == "login" { LoginView() } else {
        ZStack {
            HyggeTheme.paper.ignoresSafeArea()
            Button("Open settings preview") { presented = true }
        }
        .sheet(isPresented: $presented) {
            if screen == "main" { ProfileHubView() }
            else { NavigationStack { previewScreen }.presentationDragIndicator(.visible) }
        }
        .task {
            if store.profile.displayName.isEmpty {
                store.profile = EarningsProfile(displayName: "Mikael", interests: [.creative], locationLabel: "Austin, TX")
            }
            guard ProcessInfo.processInfo.arguments.contains("--settings-populated") else { return }
            let examples = [
                TargetSite(id: "upwork", name: "Upwork", startURLString: "https://upwork.com", category: .creative, goalTemplate: ""),
                TargetSite(id: "contra", name: "Contra", startURLString: "https://contra.com", category: .creative, goalTemplate: ""),
                TargetSite(id: "behance", name: "Behance", startURLString: "https://behance.net", category: .creative, goalTemplate: "")
            ]
            store.sites = examples
            store.accountStates = ["upwork": .watching, "contra": .profileLive, "behance": .needsVerification]
            store.hyggeEmailAddress = HyggeEmailAddress(address: "0123456789@usehygge.cc", digits: "0123456789", createdAt: "2026-11-02T12:00:00Z")
            store.filedEmailSummaries = [
                FiledEmailSummary(id: "preview", sender: "example@upwork.com", senderDomain: "upwork.com", subject: "New message about a design project", kind: "message", summary: "A client asked about your availability.")
            ]
        }
    }
    }
    @ViewBuilder private var previewScreen: some View {
        switch screen {
        case "edit": SettingsEditProfileView()
        case "invite": SettingsInviteView()
        case "logins": SettingsLoginsView()
        case "sites": ApprovedSitesView()
        case "email": SettingsEmailView()
        case "permissions": SettingsPermissionsView()
        case "flamelab": FlameLabView()
        default: ProfileHubView()
        }
    }

}
#endif
