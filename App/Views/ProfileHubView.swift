import SwiftUI
import UIKit

/// Profile hub — sections in the fixed spec order. Opened only from the
/// profile button on Home. Beliefs are editable sentences, not a form.
struct ProfileHubView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var credentialDomain = ""
    @State private var credentialUsername = ""
    @State private var credentialSecret = ""
    @State private var saveLoginSite: TargetSite?
    @State private var editingBelief: Belief?
    @State private var beliefDraft = ""
    @State private var pushAuthorization: NotificationAuthorizationKind = .notDetermined

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
                        hyggeAccount
                        hyggeEmail
                        notifications
                        loginsAndService
                        Color.clear.frame(height: 12)
                    }
                    .padding(.horizontal, 18).padding(.top, 10)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .task {
                await store.refreshSessionProfiles()
                await store.refreshHyggeEmail()
                pushAuthorization = await PermissionService.notificationAuthorization()
            }
            .sheet(item: $saveLoginSite) { site in
                CredentialSaveSheet(siteName: site.name, domain: site.domain)
                    .presentationDragIndicator(.visible)
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

    private func sectionCard<Content: View>(_ title: String, badge: String? = nil,
                                            badgeTint: Color = HyggeTheme.sageTint,
                                            @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(alignment: .center) {
                Text(title).font(.system(.headline, design: .rounded, weight: .semibold)).foregroundStyle(HyggeTheme.ink)
                Spacer()
                if let badge {
                    ZStack {
                        Circle().fill(badgeTint).frame(width: 36, height: 36)
                        Image(systemName: badge).font(.system(size: 15)).foregroundStyle(HyggeTheme.sageDeep)
                    }
                }
            }
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20).hyggeCard(radius: 26)
    }

    /// Mock labeled row: sage icon disc, bold label, plain value under it.
    private func labeledRow(_ icon: String, _ label: String, _ value: String) -> some View {
        HStack(alignment: .center, spacing: 13) {
            ZStack {
                Circle().fill(HyggeTheme.sage).frame(width: 42, height: 42)
                Image(systemName: icon).font(.system(size: 17)).foregroundStyle(.white)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(label).font(.subheadline.weight(.semibold)).foregroundStyle(HyggeTheme.ink)
                Text(value).font(.subheadline).foregroundStyle(HyggeTheme.ink)
            }
            Spacer(minLength: 0)
        }
    }

    private var aboutYou: some View {
        sectionCard("About you", badge: "pencil") {
            labeledRow("briefcase.fill", "Work you enjoy",
                       listOr(store.profile.interests.map(\.activityLabel).joined(separator: ", "), "Not set yet"))
            labeledRow("banknote.fill", "Lowest rate",
                       "$\(Int(store.profile.hourlyRateFloor))/hr — below that, I quietly drop it")
            labeledRow("mappin.and.ellipse", "Location",
                       listOr(store.profile.locationLabel, "Not set yet") + (store.profile.availabilityNotes.isEmpty ? "" : " · free \(store.profile.availabilityNotes.lowercased())"))
            Divider()
            HStack {
                Label(store.isPaused ? "Hygge is paused" : "Hygge is working for you",
                      systemImage: store.isPaused ? "pause.circle.fill" : "play.circle.fill")
                    .font(.subheadline).foregroundStyle(HyggeTheme.ink)
                Spacer()
                Button(store.isPaused ? "Resume" : "Pause") { store.setPaused(!store.isPaused) }
                    .font(.caption.weight(.semibold)).buttonStyle(.bordered).tint(HyggeTheme.sageDeep)
            }
            Button("Start over (reset everything)", role: .destructive) { store.resetAll() }
                .font(.caption)
        }
    }

    /// What Hygge has learned about you (Brief 06): beliefs plus the
    /// strongest learned leanings. Beliefs you said yourself never
    /// fade; Hygge's own guesses are shown as guesses and fade unless
    /// you confirm them.
    private var beliefsSection: some View {
        sectionCard("What Hygge has learned about you", badge: "heart.fill", badgeTint: HyggeTheme.butterTint) {
            if !store.profile.skills.isEmpty {
                beliefRow("Skills: \(store.profile.skills.joined(separator: ", "))", deletable: {
                    store.clearProfileSkills()
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
                    Text("My guess — check me").font(.caption.weight(.bold)).foregroundStyle(HyggeTheme.ember)
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
            if !store.learningProfile.topAffinities.isEmpty {
                Divider()
                Text("How your choices shape what I suggest")
                    .font(.caption.weight(.bold)).foregroundStyle(HyggeTheme.secondary)
                ForEach(Array(store.learningProfile.topAffinities.prefix(4).enumerated()), id: \.offset) { _, pair in
                    HStack(spacing: 8) {
                        Image(systemName: pair.1 >= 0 ? "arrow.up.circle" : "arrow.down.circle")
                            .font(.caption).foregroundStyle(HyggeTheme.sageDeep)
                        Text(pair.1 >= 0
                             ? "More \(pair.0.label.lowercased()) — you keep saying yes to it"
                             : "Less \(pair.0.label.lowercased()) — you keep turning it down")
                            .font(.subheadline).foregroundStyle(HyggeTheme.ink)
                        Spacer(minLength: 0)
                    }
                }
            }
            if store.learningProfile.shouldPromptRateFloorReview {
                Divider()
                Text("You have turned down \(store.learningProfile.tooLowDeclines) jobs for low pay. Your lowest rate is still $\(Int(store.profile.hourlyRateFloor))/hr — it only changes if you tell me a new one in chat.")
                    .font(.subheadline).foregroundStyle(HyggeTheme.ink)
            }
            Text("To correct anything: edit it here, delete it, or just tell me in chat.")
                .font(.caption).foregroundStyle(HyggeTheme.secondary)
        }
    }

    /// Website-navigation know-how is NOT a belief about you; it lives here,
    /// separate, so the two never get confused.
    private var siteKnowledge: some View {
        sectionCard("How Hygge navigates your sites", badge: "map") {
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
        sectionCard("Sites you approved", badge: "link") {
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
                        if let credential = store.credential(forDomain: site.domain) {
                            Text("Login saved as \(credential.username)")
                                .font(.caption).foregroundStyle(HyggeTheme.secondary)
                        }
                        if store.sessionProfile(forDomain: site.domain)?.hasProfile == true {
                            Text("Trusted sign-in saved — later visits can skip the login form")
                                .font(.caption).foregroundStyle(HyggeTheme.secondary)
                        }
                    }
                    Spacer()
                    Menu {
                        Button(store.credential(forDomain: site.domain) == nil ? "Save login" : "Update saved login") {
                            saveLoginSite = site
                        }
                        if let credential = store.credential(forDomain: site.domain) {
                            Button("Delete saved login", role: .destructive) {
                                Task { await store.deleteCredential(id: credential.id) }
                            }
                        }
                        if store.sessionProfile(forDomain: site.domain)?.hasProfile == true {
                            Button("Forget trusted sign-in") {
                                Task { await store.deleteSessionProfile(domain: site.domain) }
                            }
                        }
                        Divider()
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
        sectionCard("Your insights", badge: "chart.bar.fill", badgeTint: HyggeTheme.butterTint) {
            HStack(alignment: .top, spacing: 0) {
                statBlock(label: "Earnings", value: JournalBuilder.money(store.earningsGross),
                          caption: "amounts you confirmed")
                Rectangle().fill(HyggeTheme.hairline).frame(width: 1)
                    .padding(.horizontal, 18).padding(.vertical, 4)
                statBlock(label: "Time saved", value: TimeSaved.aboutLabel(minutes: store.timeSavedMinutes),
                          caption: "always rounded down")
                Spacer(minLength: 0)
            }
            Text("Basis: ~\(TimeSaved.minutesPerListing) min per listing read, ~\(TimeSaved.minutesPerDraft) min per draft, ~\(TimeSaved.minutesPerSearchRun) min per search.")
                .font(.caption2).foregroundStyle(HyggeTheme.secondary)
        }
    }

    private func statBlock(label: String, value: String, caption: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.body).foregroundStyle(HyggeTheme.secondary)
            Text(value).font(.system(size: 26, weight: .bold, design: .rounded)).foregroundStyle(HyggeTheme.ink)
            Text(caption).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
        }
    }

    private var invite: some View {
        sectionCard("Invite friends", badge: "gift.fill", badgeTint: HyggeTheme.peach) {
            HStack(spacing: 14) {
                ZStack {
                    RoundedRectangle(cornerRadius: 16).fill(HyggeTheme.butterTint).frame(width: 62, height: 62)
                    Image(systemName: "paperplane").font(.system(size: 24)).foregroundStyle(HyggeTheme.sageDeep)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text("Share Hygge with a friend")
                        .font(.system(.subheadline, design: .rounded, weight: .semibold)).foregroundStyle(HyggeTheme.ink)
                    Text("I saved \(TimeSaved.aboutLabel(minutes: store.timeSavedMinutes)) with Hygge")
                        .font(.caption).foregroundStyle(HyggeTheme.secondary)
                }
                Spacer(minLength: 0)
            }
            ShareLink(item: "I saved \(TimeSaved.aboutLabel(minutes: store.timeSavedMinutes)) with Hygge — it finds gigs and handles the boring parts: https://usehygge.app") {
                Text("Share")
                    .font(.body.weight(.semibold)).frame(maxWidth: .infinity)
                    .padding(.vertical, 15)
                    .background(HyggeTheme.sage, in: Capsule()).foregroundStyle(.white)
            }
        }
    }

    /// Ways into THIS Hygge account (Brief 00) — separate from the
    /// site logins Hygge uses on your behalf below.
    private var hyggeAccount: some View {
        sectionCard("Your Hygge account", badge: "person.crop.circle") {
            LoginMethodsContent()
        }
    }

    /// Brief 04: the user's own Hygge email address (the only place
    /// it is shown) plus the mail Hygge filed for them.
    private var hyggeEmail: some View {
        sectionCard("Your Hygge email address", badge: "envelope") {
            if let address = store.hyggeEmailAddress {
                Text(address.address).font(.subheadline.weight(.semibold)).foregroundStyle(HyggeTheme.ink)
                    .textSelection(.enabled)
                Text(HyggeEmail.forwardingHelp)
                    .font(.caption).foregroundStyle(HyggeTheme.secondary)
                if store.filedEmailSummaries.isEmpty {
                    Text("Nothing filed yet. Mail that arrives here will be summed up for you.")
                        .font(.caption).foregroundStyle(HyggeTheme.secondary)
                }
                ForEach(store.filedEmailSummaries) { filed in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(filed.subject.isEmpty ? "Mail from \(filed.senderDomain)" : filed.subject)
                            .font(.subheadline).foregroundStyle(HyggeTheme.ink)
                        Text(filed.summary).font(.caption).foregroundStyle(HyggeTheme.secondary)
                            .lineLimit(3)
                    }
                }
            } else {
                Text("Get an email address just for Hygge. Hygge can use it when signing you up and finishes the email steps for you — you never need to open your email. You can also forward mail from gig sites to it and Hygge will file it.")
                    .font(.caption).foregroundStyle(HyggeTheme.secondary)
                Button("Get a Hygge email address") {
                    Task { await store.chooseHyggeEmailAddress() }
                }
                .font(.caption.weight(.semibold)).buttonStyle(.bordered).tint(HyggeTheme.sageDeep)
            }
        }
    }

    /// Brief 07: the quiet way back in. Hygge asked once (the Home
    /// primer) and never nags; after a no, this section is the only
    /// place notifications come up again.
    private var notifications: some View {
        sectionCard("Notifications", badge: "bell") {
            switch pushAuthorization {
            case .authorized:
                Text("On. Hygge lets you know only when something needs you, or when new work turns up while you are away.")
                    .font(.caption).foregroundStyle(HyggeTheme.secondary)
            case .denied:
                Text("Off. Turn them on if you would like a word when something needs you — nothing is missed either way; it all waits in your feed.")
                    .font(.caption).foregroundStyle(HyggeTheme.secondary)
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
                .font(.caption.weight(.semibold)).buttonStyle(.bordered).tint(HyggeTheme.sageDeep)
            case .notDetermined:
                Text("Hygge can let you know when something needs your OK, or when new work turns up while you are away. Nothing else, ever.")
                    .font(.caption).foregroundStyle(HyggeTheme.secondary)
                Button("Yes, let me know") {
                    Task {
                        await store.allowNotifications()
                        pushAuthorization = await PermissionService.notificationAuthorization()
                    }
                }
                .font(.caption.weight(.semibold)).buttonStyle(.bordered).tint(HyggeTheme.sageDeep)
            }
        }
    }

    private var loginsAndService: some View {
        sectionCard("Site logins (kept safe)", badge: "key.fill") {
            Text("Passwords are kept safely and encrypted, typed only into the site itself — never shown in chat, drafts, or anywhere they could leak by accident. This phone keeps no copy.")
                .font(.caption).foregroundStyle(HyggeTheme.secondary)
            ForEach(store.credentialRefs) { credential in
                HStack {
                    Text(credential.domain).font(.subheadline).foregroundStyle(HyggeTheme.ink)
                    Spacer()
                    Text(credential.username).font(.caption).foregroundStyle(HyggeTheme.secondary)
                    Button(role: .destructive) {
                        Task { await store.deleteCredential(id: credential.id) }
                    } label: {
                        Image(systemName: "trash").font(.caption)
                    }
                    .accessibilityLabel("Delete saved login for \(credential.domain)")
                }
            }
            // Trusted sign-ins are separate from saved logins: forgetting
            // one keeps the other.
            ForEach(store.sessionProfileRefs.filter(\.hasProfile)) { profile in
                HStack {
                    Text(profile.domain).font(.subheadline).foregroundStyle(HyggeTheme.ink)
                    Spacer()
                    Text("Trusted sign-in").font(.caption).foregroundStyle(HyggeTheme.secondary)
                    Button {
                        Task { await store.deleteSessionProfile(domain: profile.domain) }
                    } label: {
                        Image(systemName: "trash").font(.caption)
                    }
                    .accessibilityLabel("Forget trusted sign-in for \(profile.domain)")
                }
            }
            TextField("Site domain, e.g. rover.com", text: $credentialDomain).autocorrectionDisabled()
            TextField("Username / email", text: $credentialUsername).autocorrectionDisabled()
            SecureField("Password", text: $credentialSecret)
            Button("Suggest a strong password") {
                credentialSecret = SitePasswordSuggestion.generate()
            }
            .font(.caption.weight(.semibold))
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
