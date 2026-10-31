import SwiftUI

/// Profile hub — sections in the fixed spec order. Opened only from the
/// profile button on Home. Beliefs are editable sentences, not a form.
struct ProfileHubView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var credentialDomain = ""
    @State private var credentialUsername = ""
    @State private var credentialSecret = ""
    @State private var editingBelief: Belief?
    @State private var beliefDraft = ""

    var body: some View {
        NavigationStack {
            ZStack {
                HyggeTheme.paper.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        header
                        aboutYou
                        beliefsSection
                        siteKnowledge
                        approvedSites
                        insights
                        invite
                        loginsAndService
                        Color.clear.frame(height: 12)
                    }
                    .padding(.horizontal, 18).padding(.top, 10)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }.foregroundStyle(HyggeTheme.ink)
                }
            }
            .alert("Edit belief", isPresented: Binding(get: { editingBelief != nil },
                                                       set: { if !$0 { editingBelief = nil } })) {
                TextField("Belief", text: $beliefDraft)
                Button("Save") {
                    if let belief = editingBelief { store.editBelief(id: belief.id, sentence: beliefDraft) }
                    editingBelief = nil
                }
                Button("Cancel", role: .cancel) { editingBelief = nil }
            }
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Text("You").font(.system(size: 32, weight: .bold, design: .rounded)).foregroundStyle(HyggeTheme.ink)
            FlameMark(size: 42)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16).hyggeCard(radius: 26)
    }

    private func sectionCard<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 11) {
            Text(title).font(.system(.headline, design: .rounded, weight: .semibold)).foregroundStyle(HyggeTheme.ink)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20).hyggeCard(radius: 26)
    }

    private var aboutYou: some View {
        sectionCard("About you") {
            beliefRow("You enjoy \(listOr(store.profile.interests.map(\.label).joined(separator: ", "), "—"))")
            beliefRow("Your lowest rate is $\(Int(store.profile.hourlyRateFloor))/hr. Below that, I quietly drop it.")
            beliefRow("You're based in \(listOr(store.profile.locationLabel, "—"))\(store.profile.availabilityNotes.isEmpty ? "" : ", free \(store.profile.availabilityNotes.lowercased())").")
            Divider()
            HStack {
                Label(store.isPaused ? "Hygge is paused" : "Hygge is working for you",
                      systemImage: store.isPaused ? "pause.circle.fill" : "play.circle.fill")
                    .font(.subheadline).foregroundStyle(HyggeTheme.ink)
                Spacer()
                Button(store.isPaused ? "Resume" : "Pause") { store.setPaused(!store.isPaused) }
                    .font(.caption.weight(.semibold)).buttonStyle(.bordered).tint(HyggeTheme.sageDeep)
            }
            #if DEBUG
            NavigationLink("Permissions & agent service") { BackendSettingsView() }
                .font(.caption.weight(.medium)).foregroundStyle(HyggeTheme.sageDeep)
            #endif
            Button("Start over (reset everything)", role: .destructive) { store.resetAll() }
                .font(.caption)
        }
    }

    /// Beliefs about YOU: quoted, sourced, dated — and only ever added with
    /// your confirmation. Website know-how lives in its own section below.
    private var beliefsSection: some View {
        sectionCard("What Hygge believes about you") {
            if !store.profile.skills.isEmpty {
                beliefRow("Skills: \(store.profile.skills.joined(separator: ", "))", deletable: {
                    store.profile.skills = []
                })
            }
            ForEach(store.beliefs.beliefs) { belief in
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .top, spacing: 8) {
                        Text(belief.sentence).font(.subheadline).foregroundStyle(HyggeTheme.ink)
                        Spacer()
                        Button { editingBelief = belief; beliefDraft = belief.sentence } label: {
                            Image(systemName: "pencil").font(.caption).foregroundStyle(HyggeTheme.secondary)
                        }
                        .accessibilityLabel("Edit this belief")
                        Button { store.deleteBelief(id: belief.id) } label: {
                            Image(systemName: "trash").font(.caption).foregroundStyle(HyggeTheme.secondary)
                        }
                        .accessibilityLabel("Delete this belief")
                    }
                    Text("\(belief.source.label) · since \(belief.learnedAt.formatted(.dateTime.month(.abbreviated).day()))\(belief.confidence < 0.99 ? " · \(Int(belief.confidence * 100))% sure" : "")")
                        .font(.caption2).foregroundStyle(HyggeTheme.secondary)
                }
            }
            ForEach(store.beliefs.pending) { proposal in
                VStack(alignment: .leading, spacing: 7) {
                    Text("New belief to check").font(.caption.weight(.bold)).foregroundStyle(HyggeTheme.ember)
                    Text("\"\(proposal.sentence)\"")
                        .font(.subheadline).foregroundStyle(HyggeTheme.ink)
                    HStack(spacing: 9) {
                        Button("That's right") { store.confirmBelief(id: proposal.id) }
                            .font(.caption.weight(.semibold)).buttonStyle(.borderedProminent).tint(HyggeTheme.sageDeep)
                        Button("Not quite") { store.rejectBelief(id: proposal.id) }
                            .font(.caption.weight(.semibold)).buttonStyle(.bordered).tint(HyggeTheme.secondary)
                    }
                }
                .padding(12)
                .background(HyggeTheme.butter.opacity(0.25), in: RoundedRectangle(cornerRadius: 14))
            }
            if store.beliefs.beliefs.isEmpty && store.beliefs.pending.isEmpty && store.profile.skills.isEmpty {
                Text("Nothing yet. I'll learn as we go — and I'll always check with you before saving a new belief.")
                    .font(.subheadline).foregroundStyle(HyggeTheme.secondary)
            }
            Text("To correct anything: edit it here, delete it, or just tell me in chat.")
                .font(.caption).foregroundStyle(HyggeTheme.secondary)
        }
    }

    /// Website-navigation know-how is NOT a belief about you; it lives here,
    /// separate, so the two never get confused.
    private var siteKnowledge: some View {
        sectionCard("How Hygge navigates your sites") {
            if store.siteMemory.memories.isEmpty {
                Text("No site know-how yet. I'll build it up as I work — it's about the websites, never about you.")
                    .font(.subheadline).foregroundStyle(HyggeTheme.secondary)
            }
            ForEach(store.siteMemory.memories, id: \.id) { memory in
                VStack(alignment: .leading, spacing: 2) {
                    Text(memory.domain).font(.subheadline.weight(.semibold)).foregroundStyle(HyggeTheme.ink)
                    Text("\(memory.hints.count) navigating hint\(memory.hints.count == 1 ? "" : "s") · worked \(memory.successCount) time\(memory.successCount == 1 ? "" : "s")")
                        .font(.caption).foregroundStyle(HyggeTheme.secondary)
                }
            }
        }
    }

    private var approvedSites: some View {
        sectionCard("Sites you approved") {
            let approved = store.sites.filter {
                [.hasAccount, .profileLive, .watching, .joining, .needsVerification, .paused]
                    .contains(store.accountStates[$0.id] ?? .unknown)
            }
            if approved.isEmpty {
                Text("None yet. When I suggest a place and you say yes, it lives here.")
                    .font(.subheadline).foregroundStyle(HyggeTheme.secondary)
            }
            ForEach(approved) { site in
                HStack(spacing: 10) {
                    ZStack {
                        Circle().fill(HyggeTheme.paperDeep).frame(width: 38, height: 38)
                        Text(String(site.name.prefix(1))).font(.headline).foregroundStyle(HyggeTheme.ink)
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        Text(site.name).font(.subheadline.weight(.semibold)).foregroundStyle(HyggeTheme.ink)
                        Text((store.accountStates[site.id] ?? .unknown).label)
                            .font(.caption).foregroundStyle(HyggeTheme.secondary)
                    }
                    Spacer()
                    Menu {
                        Button("Stop watching this") { store.stopWatching(siteID: site.id) }
                        Button("Disconnect (deletes saved login)", role: .destructive) {
                            Task { await store.disconnect(siteID: site.id) }
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle").foregroundStyle(HyggeTheme.secondary)
                    }
                    Text("Connected")
                        .font(.caption.weight(.semibold)).foregroundStyle(HyggeTheme.sageDeep)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(HyggeTheme.sage.opacity(0.35), in: Capsule())
                }
                .padding(.horizontal, 12).padding(.vertical, 9)
                .background(HyggeTheme.paper, in: RoundedRectangle(cornerRadius: 16))
            }
        }
    }

    private var insights: some View {
        sectionCard("Your insights") {
            HStack(alignment: .top, spacing: 26) {
                statBlock(icon: "dollarsign", disc: HyggeTheme.butter, label: "Earnings",
                          value: JournalBuilder.money(store.earningsGross),
                          caption: "amounts you confirmed")
                statBlock(icon: "clock.fill", disc: HyggeTheme.sage, label: "Time saved",
                          value: TimeSaved.aboutLabel(minutes: store.timeSavedMinutes),
                          caption: "the math is below")
                Spacer(minLength: 0)
            }
            Text("Basis: ~\(TimeSaved.minutesPerListing) min per listing read, ~\(TimeSaved.minutesPerDraft) min per draft, ~\(TimeSaved.minutesPerSearchRun) min per search — always rounded down.")
                .font(.caption2).foregroundStyle(HyggeTheme.secondary)
        }
    }

    private func statBlock(icon: String, disc: Color, label: String, value: String, caption: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            ZStack {
                Circle().fill(disc.opacity(0.55)).frame(width: 42, height: 42)
                Image(systemName: icon).font(.system(size: 17, weight: .semibold)).foregroundStyle(HyggeTheme.ink)
            }
            Text(label).font(.subheadline).foregroundStyle(HyggeTheme.ink)
            Text(value).font(.system(.title2, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink)
            Text(caption).font(.caption).foregroundStyle(HyggeTheme.secondary)
        }
    }

    private var invite: some View {
        sectionCard("Invite friends") {
            HStack(spacing: 12) {
                FlameMark(size: 30)
                Text("I saved \(TimeSaved.aboutLabel(minutes: store.timeSavedMinutes)) with Hygge")
                    .font(.system(.subheadline, design: .rounded, weight: .semibold)).foregroundStyle(HyggeTheme.ink)
            }
            ShareLink(item: "I saved \(TimeSaved.aboutLabel(minutes: store.timeSavedMinutes)) with Hygge — it finds gigs and handles the boring parts: https://usehygge.app") {
                Text("Share")
                    .font(.body.weight(.semibold)).frame(maxWidth: .infinity)
                    .padding(.vertical, 15)
                    .background(HyggeTheme.sage, in: Capsule()).foregroundStyle(.white)
            }
        }
    }

    private var loginsAndService: some View {
        sectionCard("Site logins (kept safe)") {
            Text("Passwords are kept safely and encrypted, typed only into the site itself — never shown in chat, drafts, or anywhere they could leak by accident. This phone keeps no copy.")
                .font(.caption).foregroundStyle(HyggeTheme.secondary)
            ForEach(store.credentialRefs) { credential in
                HStack {
                    Text(credential.domain).font(.subheadline).foregroundStyle(HyggeTheme.ink)
                    Spacer()
                    Text(credential.username).font(.caption).foregroundStyle(HyggeTheme.secondary)
                }
            }
            TextField("Site domain, e.g. rover.com", text: $credentialDomain).autocorrectionDisabled()
            TextField("Username / email", text: $credentialUsername).autocorrectionDisabled()
            SecureField("Password", text: $credentialSecret)
            Button("Save login safely") {
                let domain = credentialDomain, username = credentialUsername, secret = credentialSecret
                credentialSecret = ""
                Task { await store.addCredential(domain: domain, username: username, secret: secret) }
            }
            .disabled(credentialDomain.isEmpty || credentialUsername.isEmpty || credentialSecret.isEmpty)
            if let message = store.lastMessage {
                Text(message).font(.caption).foregroundStyle(HyggeTheme.secondary)
            }
        }
    }

    private func beliefRow(_ text: String, deletable: (() -> Void)? = nil) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "checkmark").font(.caption.weight(.bold)).foregroundStyle(HyggeTheme.butter)
            Text(text).font(.subheadline).foregroundStyle(HyggeTheme.ink)
            Spacer()
            if let deletable {
                Button(role: .destructive) { deletable() } label: {
                    Image(systemName: "trash").font(.caption)
                }
            }
        }
    }

    private func listOr(_ value: String, _ fallback: String) -> String {
        value.isEmpty ? fallback : value
    }
}
