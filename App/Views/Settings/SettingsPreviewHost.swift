#if DEBUG
import SwiftUI

/// Opt-in, isolated local QA. Never seeds or signs in a production account.
/// Launch with --settings-preview and --settings-populated on a fresh simulator.
struct SettingsPreviewHost: View {
    @Environment(AppStore.self) private var store
    @State private var presented = true
    @AppStorage("settingsPreviewScreen") private var screen = "main"
    var body: some View {
        if ProcessInfo.processInfo.arguments.contains("--flame-render-check") { FlameRenderCheckView() }
        else if ProcessInfo.processInfo.arguments.contains("--plan-preview") { PlanPreviewHost() }
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
            if ProcessInfo.processInfo.arguments.contains("--sites-saved-login") {
                store.credentialRefs = [CredentialRef(domain: "upwork.com", username: "alex@example.com")]
                store.sessionProfileRefs = [SessionProfileRef(domain: "upwork.com", hasProfile: true)]
            }
            store.accountStates = ["upwork": .watching, "contra": .profileLive, "behance": .needsVerification]
            if ProcessInfo.processInfo.arguments.contains("--sites-access-failure-check") {
                await verifyAccessRemovalFailures()
            }
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
        case "site-detail":
            if let site = store.sites.first { ApprovedSiteDetailView(site: site) }
        case "site-login": CredentialSaveSheet(siteName: "Upwork", domain: "upwork.com")
        case "email": SettingsEmailView()
        case "permissions": SettingsPermissionsView()
        case "flamelab": FlameLabView()
        default: ProfileHubView()
        }
    }

    /// Opt-in integration assertions against preview's closed localhost endpoint.
    /// These exercise real failure paths without a signed-in or reachable account.
    @MainActor private func verifyAccessRemovalFailures() async {
        let credential = CredentialRef(domain: "upwork.com", username: "preview@example.com")
        let session = SessionProfileRef(domain: "upwork.com", hasProfile: true)
        let memory = SiteMemory(domain: "upwork.com", kind: .login, hints: ["Preview note"])
        store.credentialRefs = [credential]
        store.sessionProfileRefs = [session]
        store.siteMemory = SiteMemoryRepository(memories: [memory])
        let removedLogin = await store.deleteCredential(id: credential.id)
        assert(!removedLogin && store.credentialRefs == [credential], "Failed deletion must keep the credential reference")
        let forgotSession = await store.deleteSessionProfile(domain: session.domain)
        assert(!forgotSession && store.sessionProfileRefs == [session], "Failed deletion must keep the session reference")
        let disconnectedWithLogin = await store.disconnect(siteID: "upwork")
        assert(!disconnectedWithLogin && store.accountStates["upwork"] == .watching, "Failed credential removal must not disconnect")
        store.credentialRefs = []
        let disconnectedWithSession = await store.disconnect(siteID: "upwork")
        assert(!disconnectedWithSession && store.accountStates["upwork"] == .watching, "Failed session removal must not disconnect")
        assert(store.sessionProfileRefs == [session] && store.siteMemory.memories == [memory], "Failed disconnect must preserve access and notes")
        print("APPROVED_SITES_FAILURE_CHECKS_PASSED: credential, session, disconnect credential failure, disconnect session failure, retained notes")
    }

}
#endif
