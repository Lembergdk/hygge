import SwiftUI

struct ApplicationsView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        NavigationStack {
            List {
                if store.applications.isEmpty {
                    Text("No applications yet. Open an opportunity and draft one — it appears here and in Approvals.")
                        .foregroundStyle(.secondary)
                }
                ForEach(store.applications) { application in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(application.title).font(.headline)
                        Text(store.siteName(id: application.siteID))
                            .font(.caption).foregroundStyle(.secondary)
                        Picker("Stage", selection: stageBinding(application.id)) {
                            ForEach(ApplicationStage.allCases, id: \.self) { stage in
                                Text(stage.label).tag(stage)
                            }
                        }
                        .pickerStyle(.menu)
                    }
                }
            }
            .navigationTitle("Applications")
        }
    }

    private func stageBinding(_ applicationID: UUID) -> Binding<ApplicationStage> {
        Binding(
            get: { store.applications.first { $0.id == applicationID }?.stage ?? .drafted },
            set: { store.setApplicationStage($0, applicationID: applicationID) })
    }
}

struct SitesView: View {
    @Environment(AppStore.self) private var store
    @State private var newName = ""
    @State private var newURL = ""
    @State private var newCategory: OpportunityCategory = .localGig
    @State private var goalDrafts: [String: String] = [:]
    @State private var browserSite: TargetSite?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("The cloud browser works on ANY site — no API or integration needed. It learns each site as it goes (see Skills).")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                let pending = store.proposals.filter { $0.status == .proposed }
                if !pending.isEmpty {
                    Section("Suggested for you — approve to join") {
                        Text("I found these from your interests. Approve one and I'll figure out its signup live on the site — asking you anything I don't know along the way.").font(.footnote).foregroundStyle(.secondary)
                        ForEach(pending) { proposal in
                            if let site = store.site(id: proposal.siteID) {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(site.name).font(.headline)
                                    Text(proposal.rationale).font(.caption).foregroundStyle(.secondary)
                                    Text(site.startURLString).font(.caption2).foregroundStyle(.secondary)
                                    HStack {
                                        Button("Join — create account") { store.approveProposal(proposalID: proposal.id, alreadyHasAccount: false) }.font(.caption)
                                        Button("I have an account") { store.approveProposal(proposalID: proposal.id, alreadyHasAccount: true) }.font(.caption)
                                        Button("Skip", role: .destructive) { store.dismissProposal(proposalID: proposal.id) }.font(.caption)
                                    }
                                }
                            }
                        }
                        Button("Find more sites") { store.findMoreProposals() }.font(.caption)
                    }
                }
                Section("Add any site") {
                    TextField("Name (optional)", text: $newName)
                    TextField("URL or domain, e.g. mycity-petsitters.com", text: $newURL)
                        .autocorrectionDisabled()
                    Picker("Category", selection: $newCategory) {
                        ForEach(OpportunityCategory.allCases) { category in
                            Text(category.label).tag(category)
                        }
                    }
                    Button("Add site") {
                        store.addSite(name: newName, urlOrDomain: newURL, category: newCategory)
                        newName = ""
                        newURL = ""
                    }
                    .disabled(newURL.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                ForEach(OpportunityCategory.allCases) { category in
                    let categorySites = store.sites.filter { $0.category == category }
                    if !categorySites.isEmpty {
                        Section(category.label) {
                            ForEach(categorySites) { site in
                                siteRow(site)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Sites")
            .sheet(item: $browserSite) { site in
                NavigationStack {
                    CloudBrowserView(urlString: site.startURLString)
                        .navigationTitle(site.name)
                }
            }
        }
    }

    private func siteRow(_ site: TargetSite) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(site.name).font(.headline)
            Text(site.startURLString).font(.caption).foregroundStyle(.secondary)
            Text((store.accountStates[site.id] ?? .unknown).label).font(.caption).foregroundStyle(.blue)
            let memories = store.siteMemory.memories.filter { $0.domain == site.domain }
            Text(memories.isEmpty
                 ? "No memory yet — the agent explores from your goal alone."
                 : "Memory: " + memories.map { "\($0.kind.label) (\($0.hints.count) hints, \($0.successCount) ok)" }.joined(separator: ", "))
                .font(.caption).foregroundStyle(.secondary)
            TextField("Goal for the agent…", text: goalBinding(site), axis: .vertical)
                .font(.callout)
            HStack {
                Button("Draft task") {
                    store.draftBrowserTask(site: site, goal: goalBinding(site).wrappedValue)
                }.font(.caption)
                Button("Sign up") { store.draftSignup(site: site) }.font(.caption)
                Button("Build profile") { store.draftSiteProfile(site: site) }.font(.caption)
                Button("Browse") { browserSite = site }.font(.caption)
            }
        }
    }

    private func goalBinding(_ site: TargetSite) -> Binding<String> {
        Binding(
            get: { goalDrafts[site.id] ?? site.goalTemplate },
            set: { goalDrafts[site.id] = $0 })
    }
}

struct MemoryView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Advisory hints the agent distilled from its own past browsing. Every mission still starts from its goal and the live page — memory is advice the agent can ignore, never a script it replays.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if store.siteMemory.memories.isEmpty {
                    Text("Nothing learned yet. Approve and run any browser mission — its trajectory becomes memory here.").foregroundStyle(.secondary)
                }
                ForEach(store.siteMemory.memories.sorted { $0.confidence > $1.confidence }) { memory in
                    Section("\(memory.kind.label) — \(memory.domain)") {
                        Text("\(memory.successCount) successful / \(memory.failureCount) failed runs")
                            .font(.caption).foregroundStyle(.secondary)
                        ForEach(memory.hints, id: \.self) { hint in
                            Text("• \(hint)").font(.callout)
                        }
                    }
                }
            }
            .navigationTitle("Site memory")
        }
    }
}

struct ProfileView: View {
    @Environment(AppStore.self) private var store
    @State private var credentialDomain = ""
    @State private var credentialUsername = ""
    @State private var credentialSecret = ""
    @State private var savingCredential = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Earnings profile") {
                    row("Name", store.profile.displayName)
                    row("Email", store.profile.email)
                    row("Headline", store.profile.headline)
                    row("Based in", store.profile.locationLabel)
                    row("Rate floor", "$\(Int(store.profile.hourlyRateFloor))/hr")
                    row("Interests", store.profile.interests.map(\.label).joined(separator: ", "))
                    row("Skills", store.profile.skills.joined(separator: ", "))
                }
                Section("Agent service") {
                    NavigationLink("Service URL & token") { BackendSettingsView() }
                    Text("Needed for live browsing, LLM onboarding and vault logins from this device.").font(.footnote).foregroundStyle(.secondary)
                }
                Section("Permissions") {
                    Text("Calendar books approved gigs, location finds nearby work, notifications ping you for matches and login checks. You can change these anytime in iOS Settings.").font(.footnote).foregroundStyle(.secondary)
                    Button("Allow calendar") { Task { _ = await PermissionService.requestCalendar() } }
                    Button("Allow notifications") { Task { _ = await PermissionService.requestNotifications() } }
                }
                Section("Site logins (server vault)") {
                    Text("Passwords are sent once to the agent service and stored encrypted (AES-256-GCM) in its vault. This device keeps only a reference — never the password. The browser worker fills login forms from the vault; secrets never appear in task drafts, logs, or prompts.")
                        .font(.footnote).foregroundStyle(.secondary)
                    ForEach(store.credentialRefs) { credential in
                        HStack {
                            Text(credential.domain)
                            Spacer()
                            Text(credential.username).foregroundStyle(.secondary)
                        }
                    }
                    TextField("Site domain, e.g. upwork.com", text: $credentialDomain)
                        .autocorrectionDisabled()
                    TextField("Username / email", text: $credentialUsername)
                        .autocorrectionDisabled()
                    SecureField("Password", text: $credentialSecret)
                    Button(savingCredential ? "Storing…" : "Store in vault") {
                        savingCredential = true
                        let domain = credentialDomain
                        let username = credentialUsername
                        let secret = credentialSecret
                        credentialSecret = ""
                        Task {
                            await store.addCredential(domain: domain, username: username, secret: secret)
                            savingCredential = false
                        }
                    }
                    .disabled(savingCredential || credentialDomain.isEmpty || credentialUsername.isEmpty || credentialSecret.isEmpty)
                }
                if let message = store.lastMessage {
                    Section { Text(message).font(.footnote).foregroundStyle(.secondary) }
                }
                Section {
                    Button("Reset demo data & onboarding", role: .destructive) { store.resetAll() }
                }
            }
            .navigationTitle("Profile")
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value.isEmpty ? "—" : value).multilineTextAlignment(.trailing)
        }
    }
}
