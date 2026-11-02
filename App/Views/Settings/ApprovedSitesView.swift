import SwiftUI

struct ApprovedSitesView: View {
    @Environment(AppStore.self) private var store
    @State private var showConversation = false
    var body: some View {
        SettingsPage(title: "Approved sites") {
            Text("You choose where Hygge works.").foregroundStyle(HyggeTheme.secondary)
            HStack {
                SettingsArtwork(name: "SettingsSites", width: 120, height: 105)
                Text(store.approvedSettingsSites.isEmpty ? "No sites approved yet" : "\(store.approvedSettingsSites.count) approved sites")
                    .font(.title2.bold()).foregroundStyle(HyggeTheme.ink)
            }
            if store.approvedSettingsSites.isEmpty {
                Text("When you approve a site, you can manage its access and saved login here.")
                    .foregroundStyle(HyggeTheme.secondary)
            } else {
                VStack(spacing: 0) {
                    ForEach(store.approvedSettingsSites) { site in
                        NavigationLink { ApprovedSiteDetailView(site: site) } label: {
                            HStack(spacing: 12) {
                                Text(String(site.name.prefix(1))).font(.title2.bold())
                                    .frame(width: 44, height: 44).background(HyggeTheme.sageTint, in: RoundedRectangle(cornerRadius: 14))
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(site.name).font(.headline).foregroundStyle(HyggeTheme.ink)
                                    Text(site.domain).font(.caption).foregroundStyle(HyggeTheme.secondary)
                                    Text((store.accountStates[site.id] ?? .unknown).label).font(.caption).foregroundStyle(HyggeTheme.sageDeep)
                                    Label(store.credential(forDomain: site.domain) == nil ? "Add login" : "Login saved", systemImage: "key")
                                        .font(.caption).foregroundStyle(HyggeTheme.secondary)
                                }
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.right").font(.caption).foregroundStyle(HyggeTheme.secondary)
                            }.padding(.vertical, 14)
                        }.buttonStyle(.plain)
                        if site.id != store.approvedSettingsSites.last?.id { Divider() }
                    }
                }.settingsSurface()
            }
            Button { showConversation = true } label: {
                Label(store.approvedSettingsSites.isEmpty ? "Suggest a site in chat" : "Suggest another site", systemImage: "bubble.left")
            }.buttonStyle(SettingsActionStyle())
            NavigationLink { SiteKnowledgeView(domain: nil) } label: {
                SettingsRow(title: "Site know-how", icon: "map", subtitle: "What Hygge has learned about these websites")
            }.buttonStyle(.plain)
        }
        .sheet(isPresented: $showConversation) { ConversationView().presentationDragIndicator(.visible) }
    }
}

struct ApprovedSiteDetailView: View {
    let site: TargetSite
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var savingLogin = false
    @State private var disconnecting = false
    @State private var confirmDisconnect = false
    var body: some View {
        SettingsPage(title: site.name) {
            Text(site.domain).font(.headline).foregroundStyle(HyggeTheme.secondary)
            Text((store.accountStates[site.id] ?? .unknown).label).foregroundStyle(HyggeTheme.sageDeep)
            VStack(alignment: .leading, spacing: 12) {
                Text("Saved login").font(.headline).foregroundStyle(HyggeTheme.ink)
                if let credential = store.credential(forDomain: site.domain) {
                    Text(credential.username).foregroundStyle(HyggeTheme.secondary)
                    Button("Update login") { savingLogin = true }.buttonStyle(SettingsActionStyle(filled: false))
                    Button("Delete saved login", role: .destructive) { Task { await store.deleteCredential(id: credential.id) } }
                        .frame(minHeight: 44)
                } else {
                    Button("Add login") { savingLogin = true }.buttonStyle(SettingsActionStyle())
                }
            }.settingsSurface()
            if store.sessionProfile(forDomain: site.domain)?.hasProfile == true {
                VStack(alignment: .leading, spacing: 12) {
                    Label("Trusted sign-in saved", systemImage: "checkmark.shield").foregroundStyle(HyggeTheme.ink)
                    Button("Forget trusted sign-in") { Task { await store.deleteSessionProfile(domain: site.domain) } }
                        .frame(minHeight: 44)
                }
            }
            NavigationLink { SiteKnowledgeView(domain: site.domain) } label: {
                SettingsRow(title: "Site know-how", icon: "map")
            }.buttonStyle(.plain)
            Button("Disconnect site", role: .destructive) { confirmDisconnect = true }.frame(minHeight: 44)
                .disabled(disconnecting)
        }
        .sheet(isPresented: $savingLogin) {
            CredentialSaveSheet(siteName: site.name, domain: site.domain).presentationDragIndicator(.visible)
        }
        .confirmationDialog("Disconnect \(site.name)?", isPresented: $confirmDisconnect, titleVisibility: .visible) {
            Button("Disconnect and delete saved login", role: .destructive) {
                disconnecting = true
                Task { await store.disconnect(siteID: site.id); dismiss() }
            }
        } message: { Text("Hygge will stop watching this site and remove its saved access and pending drafts.") }
    }
}

struct SiteKnowledgeView: View {
    let domain: String?
    @Environment(AppStore.self) private var store
    private var memories: [SiteMemory] { store.siteMemory.memories.filter { domain == nil || $0.domain == domain } }
    var body: some View {
        SettingsPage(title: "Site know-how") {
            Text("Notes about websites, separate from you.").foregroundStyle(HyggeTheme.secondary)
            if memories.isEmpty {
                SettingsArtwork(name: "SettingsSites").frame(maxWidth: .infinity)
                Text("No site know-how yet. Hygge learns as it works.").foregroundStyle(HyggeTheme.secondary)
            }
            ForEach(memories) { memory in
                VStack(alignment: .leading, spacing: 10) {
                    Text(memory.domain).font(.headline)
                    Text(memory.kind.label).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                    ForEach(Array(memory.hints.enumerated()), id: \.offset) { _, hint in
                        Text(hint).font(.subheadline)
                    }
                }.foregroundStyle(HyggeTheme.ink).settingsSurface()
            }
        }
    }
}
