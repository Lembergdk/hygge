import SwiftUI

struct ApprovedSitesView: View {
    @Environment(AppStore.self) private var store
    @State private var showConversation = false
    private var attentionCount: Int {
        store.approvedSettingsSites.filter { store.accountStates[$0.id] == .needsVerification }
            .count
    }
    var body: some View {
        SettingsPage(title: "Approved sites") {
            Text("You choose where Hygge works.").foregroundStyle(HyggeTheme.secondary)
            if store.approvedSettingsSites.isEmpty {
                VStack(alignment: .leading, spacing: 18) {
                    SettingsArtwork(name: "SettingsSites", width: 150, height: 135).frame(
                        maxWidth: .infinity)
                    Text("Find your next place to work").font(.title2.bold())
                    Text("Tell Hygge about a website you use or would like to try.")
                        .foregroundStyle(
                            HyggeTheme.secondary)
                    Button("Suggest a site in chat") { showConversation = true }.buttonStyle(
                        SettingsActionStyle())
                }.padding(.vertical, 20)
            } else {
                HStack {
                    Text(
                        "\(store.approvedSettingsSites.count) \(store.approvedSettingsSites.count == 1 ? "site" : "sites")"
                    ).font(.headline)
                    Spacer()
                    if attentionCount > 0 {
                        Label(
                            "\(attentionCount) \(attentionCount == 1 ? "needs" : "need") you",
                            systemImage: "exclamationmark.circle.fill"
                        )
                        .font(.subheadline).foregroundStyle(HyggeTheme.butterText)
                    }
                }
                VStack(spacing: 0) {
                    ForEach(store.approvedSettingsSites) { site in
                        NavigationLink {
                            ApprovedSiteDetailView(site: site)
                        } label: {
                            HStack(spacing: 12) {
                                SiteLogoTile(domain: site.domain, name: site.name, size: 44)
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(site.name).font(.headline).foregroundStyle(HyggeTheme.ink)
                                    Text(site.domain).font(.caption).foregroundStyle(
                                        HyggeTheme.secondary)
                                    SiteSettingsStatus(
                                        state: store.accountStates[site.id] ?? .unknown)
                                    if store.credential(forDomain: site.domain) != nil {
                                        Label("Login saved", systemImage: "key").font(.caption)
                                            .foregroundStyle(
                                                HyggeTheme.secondary)
                                    }
                                }
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                                    .foregroundStyle(
                                        HyggeTheme.secondary)
                            }.padding(.vertical, 16)
                        }.buttonStyle(.plain)
                        if site.id != store.approvedSettingsSites.last?.id { Divider() }
                    }
                }.settingsSurface()
                Button {
                    showConversation = true
                } label: {
                    Label("Suggest another site", systemImage: "bubble.left")
                }
                .buttonStyle(SettingsActionStyle(filled: false))
            }
        }.sheet(isPresented: $showConversation) {
            ConversationView().presentationDragIndicator(.visible)
        }
    }
}

struct SiteSettingsIdentity: View {
    var name: String
    var domain: String
    var body: some View {
        HStack(spacing: 14) {
            SiteLogoTile(domain: domain, name: name, size: 48)
            VStack(alignment: .leading, spacing: 4) {
                Text(name).font(.title3.bold()).foregroundStyle(HyggeTheme.ink)
                Text(domain).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
            }
        }
    }
}

struct ApprovedSiteDetailView: View {
    let site: TargetSite
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var savingLogin = false
    @State private var confirmDisconnect = false
    @State private var removeLogin = false
    @State private var forgetSignIn = false
    @State private var removing = false
    @State private var actionError: String?
    private var hasRememberedSignIn: Bool {
        store.sessionProfile(forDomain: site.domain)?.hasProfile == true
    }
    var body: some View {
        SettingsPage(title: site.name) {
            SiteSettingsIdentity(name: site.name, domain: site.domain)
            SiteSettingsStatus(state: store.accountStates[site.id] ?? .unknown)
            if let actionError {
                Label(actionError, systemImage: "exclamationmark.circle.fill")
                    .font(.subheadline).foregroundStyle(HyggeTheme.emberDeep)
            }
            if removing { ProgressView("Updating access…").tint(HyggeTheme.sageDeep) }
            VStack(alignment: .leading, spacing: 16) {
                Text("Sign-in").font(.headline)
                if let credential = store.credential(forDomain: site.domain) {
                    VStack(alignment: .leading, spacing: 5) {
                        Label("Saved login", systemImage: "key").font(
                            .subheadline.weight(.semibold))
                        Text(credential.username).font(.subheadline).foregroundStyle(
                            HyggeTheme.secondary)
                        Text("Used when Hygge needs to sign in again.").font(.footnote)
                            .foregroundStyle(
                                HyggeTheme.secondary)
                    }
                    HStack {
                        Button("Update login") { savingLogin = true }.foregroundStyle(
                            HyggeTheme.sageDeep)
                        Spacer()
                        Button("Remove", role: .destructive) { removeLogin = true }.foregroundStyle(
                            HyggeTheme.emberDeep)
                    }.font(.subheadline.weight(.semibold)).frame(minHeight: 44)
                } else {
                    Text("No login saved").font(.subheadline.weight(.semibold))
                    Text("Save the login you already use so Hygge can sign in when it needs to.")
                        .font(
                            .subheadline
                        ).foregroundStyle(HyggeTheme.secondary)
                    Button("Add login") { savingLogin = true }.buttonStyle(SettingsActionStyle())
                }
                if store.sessionProfile(forDomain: site.domain)?.hasProfile == true {
                    Divider()
                    VStack(alignment: .leading, spacing: 6) {
                        Label("Remembered sign-in", systemImage: "checkmark.shield").font(
                            .subheadline.weight(.semibold))
                        Text("Hygge can reuse this website’s signed-in session.").font(.footnote)
                            .foregroundStyle(HyggeTheme.secondary)
                        Button("Forget sign-in") { forgetSignIn = true }
                            .font(.subheadline.weight(.semibold)).foregroundStyle(
                                HyggeTheme.sageDeep
                            ).frame(
                                minHeight: 44)
                    }
                }
            }.foregroundStyle(HyggeTheme.ink).settingsSurface()
            VStack(alignment: .leading, spacing: 4) {
                Button("Disconnect site", role: .destructive) { confirmDisconnect = true }
                    .foregroundStyle(HyggeTheme.emberDeep).frame(minHeight: 44)
                Text("Stop Hygge’s work here and remove its saved access.").font(.footnote)
                    .foregroundStyle(
                        HyggeTheme.secondary)
            }
        }
        .disabled(removing)
        .interactiveDismissDisabled(removing)
        .sheet(isPresented: $savingLogin) {
            CredentialSaveSheet(siteName: site.name, domain: site.domain).presentationDragIndicator(
                .visible)
        }
        .alert("Disconnect \(site.name)?", isPresented: $confirmDisconnect) {
            Button("Disconnect \(site.name)", role: .destructive) {
                performRemoval { await store.disconnect(siteID: site.id) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "Hygge will stop working here, remove the saved login and remembered sign-in, and clear pending drafts. It won’t suggest this site again."
            )
        }
        .alert("Remove saved login?", isPresented: $removeLogin) {
            Button("Remove saved login", role: .destructive) {
                guard let credential = store.credential(forDomain: site.domain) else { return }
                performRemoval { await store.deleteCredential(id: credential.id) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                hasRememberedSignIn
                    ? "Hygge will forget this username and password. Its remembered sign-in will remain."
                    : "Hygge will forget this username and password. You can add a login again later."
            )
        }
        .alert("Forget sign-in?", isPresented: $forgetSignIn) {
            Button("Forget sign-in", role: .destructive) {
                performRemoval { await store.deleteSessionProfile(domain: site.domain) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                store.credential(forDomain: site.domain) != nil
                    ? "The saved login will remain. Hygge may use it to sign in again."
                    : "Hygge will forget this website’s signed-in session. You may need to sign in again later."
            )
        }
    }
    private func performRemoval(_ operation: @escaping @MainActor () async -> Bool) {
        guard !removing else { return }
        removing = true
        actionError = nil
        Task { @MainActor in
            let succeeded = await operation()
            removing = false
            if !succeeded {
                actionError = "We couldn’t update access. Please try again."
                if let actionError { AccessibilityNotification.Announcement(actionError).post() }
            } else if store.accountStates[site.id] == .disconnected {
                dismiss()
            }
        }
    }

}

private struct SiteSettingsStatus: View {
    let state: SiteAccountState
    private var icon: String {
        switch state {
        case .needsVerification: return "exclamationmark.circle.fill"
        case .profileLive, .watching, .hasAccount: return "checkmark.circle"
        case .joining: return "clock"
        case .paused: return "pause.circle"
        default: return "circle"
        }
    }
    private var color: Color {
        if state == .needsVerification { return HyggeTheme.butterText }
        if state.isWatching || state == .hasAccount { return HyggeTheme.sageDeep }
        return HyggeTheme.secondary
    }
    var body: some View {
        Label(state.label, systemImage: icon).font(.subheadline).foregroundStyle(color)
    }
}
