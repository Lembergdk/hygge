import SwiftUI

private struct HomeScrollOffsetKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// Home is a feed — the only destination. Fixed order: calm header, pinned
/// needs-you (never scrolls away conceptually — it sits on top), then the
/// journal. No tab bar anywhere in the app.
struct HomeFeedView: View {
    @Environment(AppStore.self) private var store
    @State private var showConversation = false
    @State private var showProfile = false
    @State private var showYourWork = false
    @State private var moneyApplication: ApplicationRecord?
    @State private var earlierExpanded = false
    @State private var expandedWhy: Set<String> = []
    @State private var needsExpanded = false
    @State private var consentsExpanded = false
    @State private var showPauseConfirm = false
    @State private var editingTask: AgentTask?
    @State private var reviewQueue: [AgentTask] = []
    @State private var reviewTotal = 0
    @State private var flameDimmed = false
    @State private var dimTask: Task<Void, Never>?

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            HyggeTheme.paper.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    header
                    if store.isPaused {
                        pausedCard
                    } else {
                        consentZone
                        pinnedZone
                    }
                    journal
                    Color.clear.frame(height: 100) // the flame never covers the last action
                }
                .background(GeometryReader { geo in
                    Color.clear.preference(key: HomeScrollOffsetKey.self,
                                           value: geo.frame(in: .named("homeScroll")).minY)
                })
                .padding(.horizontal, 20).padding(.top, 8)
            }
            .coordinateSpace(name: "homeScroll")
            .onPreferenceChange(HomeScrollOffsetKey.self) { _ in
                // While scrolling, the flame fades back so it never hides text.
                flameDimmed = true
                dimTask?.cancel()
                dimTask = Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 650_000_000)
                    if !Task.isCancelled { flameDimmed = false }
                }
            }
            FloatingFlame(state: flameState, dimmed: flameDimmed) {
                showConversation = true
            } onLongPress: {
                showPauseConfirm = true
            }
            .padding(.trailing, 18).padding(.bottom, 14)
        }
        .confirmationDialog(store.isPaused ? "Resume Hygge?" : "Pause Hygge?",
                            isPresented: $showPauseConfirm, titleVisibility: .visible) {
            Button(store.isPaused ? "Resume" : "Pause everything", role: store.isPaused ? .none : .destructive) {
                store.setPaused(!store.isPaused)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(store.isPaused ? "Hygge will start looking again right away." : "Hygge stops searching, sending and booking until you resume. Nothing is lost.")
        }
        .sheet(isPresented: $showConversation) { ConversationView().presentationDragIndicator(.visible) }
        .sheet(isPresented: $showProfile) { ProfileHubView().presentationDragIndicator(.visible) }
        .sheet(isPresented: $showYourWork) { YourWorkView().presentationDragIndicator(.visible) }
        .sheet(item: $moneyApplication) { application in
            MoneyConfirmationView(application: application)
        }
        .sheet(item: $editingTask) { task in
            NavigationStack { TaskDetailView(taskID: task.id) }
        }
        // "I already have a profile" asks for the login right away;
        // the joining work starts when the sheet closes.
        .sheet(item: Binding(get: { store.pendingCredentialSave },
                             set: { store.pendingCredentialSave = $0 })) { request in
            CredentialSaveSheet(siteName: request.siteName, domain: request.domain) { saved in
                store.finishCredentialSave(request, saved: saved)
            }
            .presentationDragIndicator(.visible)
        }
        .sheet(item: Binding(get: { reviewQueue.first },
                             set: { if $0 == nil, !reviewQueue.isEmpty { reviewQueue.removeFirst() } })) { task in
            NavigationStack {
                TaskDetailView(taskID: task.id)
                    .toolbar {
                        ToolbarItem(placement: .principal) {
                            Text("Reviewing \(reviewTotal - reviewQueue.count + 1) of \(reviewTotal)")
                                .font(.caption.weight(.semibold)).foregroundStyle(HyggeTheme.secondary)
                        }
                    }
            }
        }
    }

    /// The full paused home state: nothing asks for attention, resume is one tap.
    private var pausedCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                FlameMark(size: 30)
                Text("Hygge is paused")
                    .font(.system(.headline, design: .rounded, weight: .semibold))
                    .foregroundStyle(HyggeTheme.ink)
            }
            Text("No searching, sending, or booking until you say so. Your work and drafts are exactly as you left them.")
                .font(.subheadline).foregroundStyle(HyggeTheme.secondary)
            Button("Resume Hygge") { store.setPaused(false) }
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 18).padding(.vertical, 11)
                .background(HyggeTheme.emberDeep, in: Capsule()).foregroundStyle(.white)
        }
        .padding(17).hyggeCard(radius: 24)
    }

    private var flameState: FlameState {
        if store.isAgentWorking { return .working }
        return store.needsYouCount > 0 ? .needsYou(store.needsYouCount) : .asleep
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(greeting)
                        .font(.system(size: 38, weight: .bold, design: .rounded))
                        .foregroundStyle(HyggeTheme.ink)
                        .lineLimit(2).minimumScaleFactor(0.8)
                    Text(store.isPaused ? "Hygge is paused. Everything is as you left it."
                                        : "Here's what needs your attention today")
                        .font(.body).foregroundStyle(HyggeTheme.sageDeep)
                }
                Spacer()
                Button { showProfile = true } label: {
                    ZStack {
                        Circle().fill(HyggeTheme.sageTint).frame(width: 62, height: 62)
                        Text(initials).font(.system(.title3, design: .rounded, weight: .bold))
                            .foregroundStyle(HyggeTheme.ink)
                    }
                }
                .accessibilityLabel("Profile")
            }
            if store.pendingValue > 0 {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("FOUND FOR YOU").font(.caption2.weight(.bold)).foregroundStyle(HyggeTheme.sageDeep)
                        Text(JournalBuilder.money(store.pendingValue))
                            .font(.system(.title2, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink)
                        Text("In drafts ready below — nothing sent yet.")
                            .font(.caption).foregroundStyle(HyggeTheme.secondary)
                    }
                    Spacer()
                    FlameMark(size: 26)
                }
                .padding(16).hyggeCard(radius: 20)
            }
            if let message = store.lastMessage {
                Text(message).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
            }
            if let syncError = store.lastSyncError, syncError != store.lastMessage {
                // Honest offline write state: cached here, not saved yet.
                Label(syncError, systemImage: "wifi.slash")
                    .font(.caption).foregroundStyle(HyggeTheme.emberDeep)
            }
        }
    }

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        let name = store.profile.displayName.split(separator: " ").first.map(String.init) ?? ""
        let base = hour < 12 ? "Good morning" : (hour < 18 ? "Good afternoon" : "Good evening")
        return name.isEmpty ? base : "\(base), \(name)"
    }

    private var initials: String {
        let parts = store.profile.displayName.split(separator: " ")
        let letters = parts.prefix(2).compactMap { $0.first.map(String.init) }.joined()
        return letters.isEmpty ? "You" : letters.uppercased()
    }

    // MARK: A place to start (at most one suggestion up front)

    @ViewBuilder
    private var consentZone: some View {
        let pending = store.proposals.filter { $0.status == .proposed }
        if !pending.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text("A place to start")
                    .font(.system(.title3, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink)
                if let first = pending.first { consentCard(first) }
                if pending.count > 1 {
                    if consentsExpanded {
                        ForEach(pending.dropFirst()) { consentCard($0) }
                    } else {
                        Button("More places when you're ready (\(pending.count - 1))") { consentsExpanded = true }
                            .font(.subheadline.weight(.medium)).foregroundStyle(HyggeTheme.sageDeep)
                    }
                }
            }
        }
    }

    // MARK: Pinned needs-you

    private var pinnedZone: some View {
        VStack(alignment: .leading, spacing: 12) {
            if store.needsYouCount == 0 {
                if store.proposals.allSatisfy({ $0.status != .proposed }) {
                    HStack(spacing: 8) {
                        Image(systemName: "checkmark.circle.fill").foregroundStyle(HyggeTheme.sage)
                        Text("Nothing needs you right now.").font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                    }
                }
            } else {
                HStack {
                    Text("Needs you").font(.system(.title3, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink)
                    Text("\(store.needsYouCount)")
                        .font(.caption.weight(.bold)).foregroundStyle(.white)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(HyggeTheme.emberDeep, in: Capsule())
                    Spacer()
                }
                let cards = needsYouCards
                ForEach(cards.prefix(needsExpanded ? cards.count : 3)) { card in AnyView(card.content()) }
                if cards.count > 3 && !needsExpanded {
                    Button("Show \(cards.count - 3) more") { needsExpanded = true }
                        .font(.subheadline.weight(.medium)).foregroundStyle(HyggeTheme.sageDeep)
                }
            }
        }
    }

    private var needsYouCards: [NeedsYouCard] {
        var cards: [NeedsYouCard] = []
        for task in store.tasks where task.status == .needsHuman {
            cards.append(NeedsYouCard(id: "task-\(task.id)") { taskCard(task) })
        }
        let awaiting = store.tasks.filter { $0.status == .awaitingApproval }
        for batch in TaskBatching.groups(awaiting) {
            if batch.count > 1 {
                cards.append(NeedsYouCard(id: "batch-\(batch.map(\.id.uuidString).joined(separator: ","))") { batchCard(batch) })
            } else if let task = batch.first {
                cards.append(NeedsYouCard(id: "task-\(task.id)") { taskCard(task) })
            }
        }
        return cards
    }

}

private struct NeedsYouCard: Identifiable {
    var id: String
    @ViewBuilder var content: () -> any View
}

extension HomeFeedView {
    // MARK: Cards

    private func consentCard(_ proposal: ProposedSite) -> some View {
        let site = store.site(id: proposal.siteID)
        return VStack(alignment: .leading, spacing: 15) {
            tagLabel("New place to find work", color: HyggeTheme.sageDeep)
            HStack(alignment: .top, spacing: 13) {
                iconTile(categoryIcon(site?.category))
                VStack(alignment: .leading, spacing: 3) {
                    Text(site?.name ?? proposal.siteID)
                        .font(.system(.title3, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink)
                    Text(proposal.rationale)
                        .font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                        .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            Divider().overlay(HyggeTheme.hairline)
            VStack(alignment: .leading, spacing: 11) {
                factRow("banknote", proposal.payPattern)
                factRow("person.crop.rectangle", "Shared: \(proposal.dataShared.lowercased())")
                factRow("checkmark.shield", "Checks: \(proposal.verification.lowercased())")
            }
            approveButton("Create my account") { store.approveProposal(proposalID: proposal.id, alreadyHasAccount: false) }
            HStack {
                quietButton("I have one") { store.approveProposal(proposalID: proposal.id, alreadyHasAccount: true) }
                Spacer()
                quietButton("Not this site") { store.dismissProposal(proposalID: proposal.id) }
            }
            Text("One yes is all it takes — I'll handle the signup and only stop for things only you can do.")
                .font(.caption).foregroundStyle(HyggeTheme.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
                .multilineTextAlignment(.center)
        }
        .padding(20).hyggeCard(radius: 26)
    }

    private func taskCard(_ task: AgentTask) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            tagLabel(task.status == .needsHuman ? "Pinned · Needs you" : "Draft · nothing sent yet",
                     color: task.status == .needsHuman ? HyggeTheme.emberDeep : HyggeTheme.sageDeep,
                     foreground: task.status == .needsHuman ? .white : HyggeTheme.onSage)
            HStack(alignment: .top, spacing: 13) {
                iconTile(categoryIcon(opportunity(for: task)?.category))
                VStack(alignment: .leading, spacing: 3) {
                    Text(task.title)
                        .font(.system(.headline, design: .rounded, weight: .semibold))
                        .foregroundStyle(HyggeTheme.ink).lineLimit(2)
                    if let take = hyggesTake(task) {
                        Text(take).font(.subheadline).foregroundStyle(HyggeTheme.sageDeep).lineLimit(3)
                    }
                }
                Spacer(minLength: 0)
            }
            if !evidenceLines(task).isEmpty {
                Divider().overlay(HyggeTheme.hairline)
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(evidenceLines(task).prefix(3).enumerated()), id: \.offset) { _, line in
                        factRow(evidenceIcon(line), line)
                    }
                }
            }
            if !task.informationRequests.isEmpty {
                ForEach(task.informationRequests, id: \.self) { question in
                    Label(question, systemImage: "questionmark.circle")
                        .font(.subheadline).foregroundStyle(HyggeTheme.ink)
                }
            } else if let draft = mainDraft(task) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Your message").font(.caption).foregroundStyle(HyggeTheme.secondary)
                    Text(draft).font(.subheadline).foregroundStyle(HyggeTheme.ink).lineLimit(4)
                }
            }
            if task.status == .needsHuman {
                approveButton("Answer / take over") { editingTask = task }
            } else {
                approveButton("Approve") { Task { await store.approveAndRun(taskID: task.id) } }
                HStack {
                    quietButton("Edit") { editingTask = task }
                    Spacer()
                    Menu("Not now") {
                        Button("Too low") { notNow(task, reason: "too low") }
                        Button("Too far") { notNow(task, reason: "too far") }
                        Button("Not my thing") { notNow(task, reason: "not their thing") }
                        Button("Just busy") { notNow(task, reason: "just busy") }
                    }
                    .font(.subheadline.weight(.medium)).foregroundStyle(HyggeTheme.secondary)
                }
            }
        }
        .padding(20).hyggeCard(radius: 26)
    }

    private func opportunity(for task: AgentTask) -> Opportunity? {
        guard let id = task.opportunityID else { return nil }
        return store.opportunities.first { $0.id == id }
    }

    private func evidenceIcon(_ line: String) -> String {
        if line.hasPrefix("$") || line.hasPrefix("Pay") { return "dollarsign" }
        if line.contains("Remote") || line.contains("In person") { return "mappin" }
        return "calendar"
    }

    private func batchCard(_ batch: [AgentTask]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            tagLabel("Drafts — nothing sent yet", color: HyggeTheme.sageDeep)
            Text("\(batch.count) similar applications")
                .font(.system(.headline, design: .rounded, weight: .semibold)).foregroundStyle(HyggeTheme.ink)
            Text("Identical draft, checked word for word, for \(batch.count) listings on \(store.siteName(id: batch.first?.siteID ?? "")). If one stalls, the rest stop too.")
                .font(.subheadline).foregroundStyle(HyggeTheme.secondary)
            if let draft = batch.first.flatMap(mainDraft) {
                Text(draft).font(.subheadline).foregroundStyle(HyggeTheme.ink).lineLimit(5)
            }
            HStack(spacing: 9) {
                approveButton("Approve all \(batch.count)") {
                    Task { await store.approveBatch(taskIDs: batch.map(\.id)) }
                }
                Button("Review each") {
                    reviewQueue = batch
                    reviewTotal = batch.count
                }
                .font(.subheadline.weight(.medium)).foregroundStyle(HyggeTheme.secondary)
            }
        }
        .padding(20).hyggeCard(radius: 26)
    }

    private func consentFact(_ icon: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon).font(.caption).foregroundStyle(HyggeTheme.sageDeep).frame(width: 16)
            Text(text).font(.caption).foregroundStyle(HyggeTheme.ink)
        }
    }

    /// A recommendation only when confidence clears the bar; below it, the
    /// card shows evidence and stays neutral.
    private func hyggesTake(_ task: AgentTask) -> String? {
        if let oppID = task.opportunityID,
           let opp = store.opportunities.first(where: { $0.id == oppID }) {
            return MatchEngine.recommendation(for: MatchEngine.evaluate(profile: store.profile, opportunity: opp))
        }
        switch task.kind {
        case .signup: return "A new place to find work you enjoy. I'll figure out the signup and ask about anything I don't know."
        case .buildProfile: return "Your profile, written from what I know about you. Worth a quick read before it goes live."
        case .discover: return "A fresh look for work at or above your floor. Nothing leaves the app."
        default: return nil
        }
    }

    private func evidenceLines(_ task: AgentTask) -> [String] {
        guard let oppID = task.opportunityID,
              let opp = store.opportunities.first(where: { $0.id == oppID }) else { return [] }
        return MatchEngine.evaluate(profile: store.profile, opportunity: opp).evidence
    }

    private func mainDraft(_ task: AgentTask) -> String? {
        task.draftedPayload["coverLetter"] ?? task.draftedPayload["profileBio"] ?? task.draftedPayload["checklist"]
    }

    private func notNow(_ task: AgentTask, reason: String) {
        store.reject(taskID: task.id)
        switch reason {
        case "too far":
            store.proposeBelief(sentence: "Prefers work close to home", source: .learnedFromWork, confidence: 0.6)
            store.appendChat(fromAgent: true, text: "Noted — that one was too far. If you prefer work close to home, confirm it in your profile and I'll weight distance more.")
        case "not their thing":
            store.proposeBelief(sentence: "Turns down \(store.siteName(id: task.siteID)) work that isn't their thing", source: .learnedFromWork, confidence: 0.55)
            store.appendChat(fromAgent: true, text: "Noted — not your thing. I may have a belief to check with you in your profile.")
        default:
            store.appendChat(fromAgent: true, text: "Noted — \(task.title) was \(reason).")
        }
    }

    /// Tags come in contrast-safe pairs: sage fills take onSage text,
    /// ember fills are always the deep ember (white passes 5.1:1).
    private func tagLabel(_ text: String, color: Color, foreground: Color = HyggeTheme.onSage) -> some View {
        Text(text)
            .font(.caption.weight(.bold)).foregroundStyle(foreground)
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(color, in: Capsule())
    }

    /// The one primary action per card: full-width ember capsule (mocks).
    private func approveButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity).padding(.vertical, 15)
                .background(HyggeTheme.emberDeep, in: Capsule()).foregroundStyle(.white)
        }
        .buttonStyle(.plain)
    }

    private func factRow(_ icon: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .medium)).foregroundStyle(HyggeTheme.ember)
                .frame(width: 22)
            Text(text).font(.subheadline).foregroundStyle(HyggeTheme.ink)
            Spacer(minLength: 0)
        }
    }

    private func iconTile(_ icon: String) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 16).fill(HyggeTheme.sageTint).frame(width: 54, height: 54)
            Image(systemName: icon).font(.system(size: 23)).foregroundStyle(HyggeTheme.sageDeep)
        }
    }

    private func categoryIcon(_ category: OpportunityCategory?) -> String {
        switch category {
        case .petCare: return "pawprint.fill"
        case .freelance, .remoteJob: return "laptopcomputer"
        case .localGig: return "hammer.fill"
        case .delivery: return "car.fill"
        case .creative: return "paintpalette.fill"
        case .tutoring: return "book.fill"
        case .homeServices: return "house.fill"
        case .community: return "person.3.fill"
        case nil: return "sparkles"
        }
    }

    private func quietButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .font(.subheadline.weight(.medium)).foregroundStyle(HyggeTheme.secondary)
    }

    // MARK: Journal

    private var journal: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Journal").font(.system(.title3, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink)
                Spacer()
                Button("Your work") { showYourWork = true }
                    .font(.subheadline.weight(.medium)).foregroundStyle(HyggeTheme.sageDeep)
            }
            let entries = store.journalEntries
            let since = entries.filter { $0.date > store.visitMarker }
            let earlier = entries.filter { $0.date <= store.visitMarker }
            Text("Since your last visit").font(.caption.weight(.semibold)).foregroundStyle(HyggeTheme.secondary)
            if since.isEmpty && earlier.isEmpty {
                journalRow(sentence: store.isPaused
                    ? "Paused. Everything is exactly as you left it."
                    : "Looking tonight. Nothing to report yet — and that's fine.",
                           why: "", id: "quiet-first")
            } else if since.isEmpty {
                journalRow(sentence: "All quiet — nothing new worth your attention.", why: "", id: "quiet")
            }
            ForEach(since) { entry in journalEntryView(entry) }
            // Honest zero: no witnessed work yet, no claim of time saved.
            if store.timeSavedMinutes > 0 { timeSavedCard }
            if !earlier.isEmpty {
                Button {
                    withAnimation { earlierExpanded.toggle() }
                } label: {
                    HStack {
                        Text("Earlier").font(.subheadline.weight(.semibold)).foregroundStyle(HyggeTheme.ink)
                        Image(systemName: earlierExpanded ? "chevron.up" : "chevron.down")
                            .font(.caption).foregroundStyle(HyggeTheme.secondary)
                        Spacer()
                    }
                }
                if earlierExpanded {
                    ForEach(earlier) { entry in journalEntryView(entry) }
                }
            }
        }
    }

    private func journalEntryView(_ entry: JournalEntry) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(JournalBuilder.dayLabel(for: entry.date))
                .font(.caption.weight(.bold)).foregroundStyle(HyggeTheme.butterText)
                .padding(.horizontal, 10).padding(.vertical, 4)
                .background(HyggeTheme.butterTint, in: Capsule())
            Text(entry.sentence).font(.body).foregroundStyle(HyggeTheme.ink).lineSpacing(3)
            if !entry.why.isEmpty {
                if expandedWhy.contains(entry.id) {
                    Text(entry.why).font(.caption).foregroundStyle(HyggeTheme.secondary)
                }
                Button(expandedWhy.contains(entry.id) ? "Hide why" : "Why did Hygge do this?") {
                    if expandedWhy.contains(entry.id) { expandedWhy.remove(entry.id) } else { expandedWhy.insert(entry.id) }
                }
                .font(.caption.weight(.medium)).foregroundStyle(HyggeTheme.sageDeep)
            }
            if let appID = entry.applicationID,
               let app = store.applications.first(where: { $0.id == appID }), app.stage == .completed {
                Button("See the breakdown") { moneyApplication = app }
                    .font(.caption.weight(.medium)).foregroundStyle(HyggeTheme.sageDeep)
            }
        }
        .padding(18).hyggeCard(radius: 22)
    }

    private func journalRow(sentence: String, why: String, id: String) -> some View {
        Text(sentence).font(.body).foregroundStyle(HyggeTheme.ink).lineSpacing(3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18).hyggeCard(radius: 22)
    }

    private var cozyLine: String {
        let afternoons = TimeSaved.cozyAfternoons(minutes: store.timeSavedMinutes)
        if afternoons >= 1 { return "That's about \(afternoons) cozy afternoon\(afternoons == 1 ? "" : "s") back. The math lives in your profile." }
        return "Time back for the good stuff. The math lives in your profile."
    }

    private var durationLabel: String {
        let minutes = store.timeSavedMinutes
        let h = minutes / 60, m = minutes % 60
        if h == 0 { return "\(m)m" }
        return m == 0 ? "\(h)h" : "\(h)h \(m)m"
    }

    private var timeSavedCard: some View {
        HStack(spacing: 15) {
            ZStack {
                Circle().fill(HyggeTheme.sage.opacity(0.45)).frame(width: 52, height: 52)
                Image(systemName: "clock").font(.system(size: 21)).foregroundStyle(HyggeTheme.sageDeep)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text("Time saved so far").font(.subheadline).foregroundStyle(HyggeTheme.ink)
                Text(durationLabel)
                    .font(.system(size: 27, weight: .bold, design: .rounded)).foregroundStyle(HyggeTheme.ink)
                Text(cozyLine).font(.caption).foregroundStyle(HyggeTheme.secondary)
            }
            Spacer()
        }
        .padding(18)
        .background(HyggeTheme.sageTint, in: RoundedRectangle(cornerRadius: 22))
    }
}
