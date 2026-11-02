import Foundation
import Observation

struct StoreSnapshot: Codable {
    init(profile: EarningsProfile, hasOnboarded: Bool, sites: [TargetSite],
         siteMemory: SiteMemoryRepository, credentialRefs: [CredentialRef],
         opportunities: [Opportunity], tasks: [AgentTask], applications: [ApplicationRecord],
         proposals: [ProposedSite], accountStates: [String: SiteAccountState],
         chatTranscript: [ChatEntry], activityEvents: [ActivityEvent], isPaused: Bool,
         lastVisitAt: Date?, beliefs: BeliefBook = BeliefBook(), searchEvidence: [SearchEvidence] = [],
         feedbackEvents: [FeedbackEvent] = [], learningProfile: LearningProfile = LearningProfile()) {
        self.profile = profile; self.hasOnboarded = hasOnboarded; self.sites = sites
        self.siteMemory = siteMemory; self.credentialRefs = credentialRefs
        self.opportunities = opportunities; self.tasks = tasks; self.applications = applications
        self.proposals = proposals; self.accountStates = accountStates
        self.chatTranscript = chatTranscript; self.activityEvents = activityEvents
        self.isPaused = isPaused; self.lastVisitAt = lastVisitAt
        self.beliefs = beliefs; self.searchEvidence = searchEvidence
        self.feedbackEvents = feedbackEvents; self.learningProfile = learningProfile
    }
    var profile: EarningsProfile
    var hasOnboarded: Bool
    var sites: [TargetSite]
    var siteMemory: SiteMemoryRepository
    var credentialRefs: [CredentialRef]
    var opportunities: [Opportunity]
    var tasks: [AgentTask]
    var applications: [ApplicationRecord]
    var proposals: [ProposedSite]
    var accountStates: [String: SiteAccountState]
    var chatTranscript: [ChatEntry]
    var activityEvents: [ActivityEvent]
    var isPaused: Bool
    var lastVisitAt: Date?
    var beliefs: BeliefBook = BeliefBook()
    var searchEvidence: [SearchEvidence] = []
    var feedbackEvents: [FeedbackEvent] = []
    var learningProfile: LearningProfile = LearningProfile()

    /// Tolerant decode: fields added in later versions default instead of
    /// failing the whole snapshot (which would wipe the user's state).
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        profile = try c.decodeIfPresent(EarningsProfile.self, forKey: .profile) ?? EarningsProfile()
        hasOnboarded = try c.decodeIfPresent(Bool.self, forKey: .hasOnboarded) ?? false
        sites = try c.decodeIfPresent([TargetSite].self, forKey: .sites) ?? SeedSites.all
        siteMemory = try c.decodeIfPresent(SiteMemoryRepository.self, forKey: .siteMemory) ?? SiteMemoryRepository()
        credentialRefs = try c.decodeIfPresent([CredentialRef].self, forKey: .credentialRefs) ?? []
        opportunities = try c.decodeIfPresent([Opportunity].self, forKey: .opportunities) ?? []
        tasks = try c.decodeIfPresent([AgentTask].self, forKey: .tasks) ?? []
        applications = try c.decodeIfPresent([ApplicationRecord].self, forKey: .applications) ?? []
        proposals = try c.decodeIfPresent([ProposedSite].self, forKey: .proposals) ?? []
        accountStates = try c.decodeIfPresent([String: SiteAccountState].self, forKey: .accountStates) ?? [:]
        chatTranscript = try c.decodeIfPresent([ChatEntry].self, forKey: .chatTranscript) ?? []
        activityEvents = try c.decodeIfPresent([ActivityEvent].self, forKey: .activityEvents) ?? []
        isPaused = try c.decodeIfPresent(Bool.self, forKey: .isPaused) ?? false
        lastVisitAt = try c.decodeIfPresent(Date.self, forKey: .lastVisitAt)
        beliefs = try c.decodeIfPresent(BeliefBook.self, forKey: .beliefs) ?? BeliefBook()
        searchEvidence = try c.decodeIfPresent([SearchEvidence].self, forKey: .searchEvidence) ?? []
        feedbackEvents = try c.decodeIfPresent([FeedbackEvent].self, forKey: .feedbackEvents) ?? []
        learningProfile = try c.decodeIfPresent(LearningProfile.self, forKey: .learningProfile) ?? LearningProfile()
    }
}

@Observable
final class AppStore {
    var profile = EarningsProfile()
    var hasOnboarded = false
    var sites: [TargetSite] = SeedSites.all
    var siteMemory = SiteMemoryRepository()
    var credentialRefs: [CredentialRef] = []
    var opportunities: [Opportunity] = []
    var tasks: [AgentTask] = []
    var applications: [ApplicationRecord] = []
    var proposals: [ProposedSite] = []
    var accountStates: [String: SiteAccountState] = [:]
    var chatTranscript: [ChatEntry] = []
    var activityEvents: [ActivityEvent] = []
    var isPaused = false
    var beliefs = BeliefBook()
    var searchEvidence: [SearchEvidence] = []
    /// Brief 06: every decision, structured. Synced per user; the
    /// server derives the ranking model from these events.
    var feedbackEvents: [FeedbackEvent] = []
    var learningProfile = LearningProfile()
    var lastVisitAt: Date?
    /// Captured at launch: journal grouping is 'since' this moment.
    var visitMarker: Date = .distantPast
    var lastMessage: String?

    // Brief 01: the local snapshot below is a cache. Once the one-time
    // migration verifies, `isBackendFirst` flips and pulls/pushes keep
    // this device in step with the per-user server state.
    private(set) var isBackendFirst = UserDefaults.standard.bool(forKey: AppStore.backendFirstKey)
    private(set) var hasRealServerFeedItem = false
    private(set) var isSyncing = false
    /// Set only when a write could not be saved — reads quietly serve
    /// the cache, writes never pretend. Cleared by the next good push.
    var lastSyncError: String?
    @ObservationIgnored private var pushTask: Task<Void, Never>?
    static let backendFirstKey = "hyggeBackendFirstV1"
    /// A pending "save this login" ask (Brief 03). Set the moment the
    /// user confirms they already have a profile on a site and no
    /// login is saved yet; the joining work waits for the sheet.
    struct CredentialSaveRequest: Identifiable {
        var id = UUID()
        var siteID: String
        var siteName: String
        var domain: String
        var taskID: UUID?
    }
    var pendingCredentialSave: CredentialSaveRequest?

    /// Trusted sign-in metadata, refreshed from the helper. Transient
    /// by design — the helper is the source of truth.
    var sessionProfileRefs: [SessionProfileRef] = []

    /// Brief 04: the user's own Hygge email address and the mail
    /// Hygge filed for them. Transient — refreshed from the user's
    /// own inbox; codes never come to the device.
    var hyggeEmailAddress: HyggeEmailAddress?
    var filedEmailSummaries: [FiledEmailSummary] = []

    /// Brief 07 push: the one-time Home primer (shown only after the
    /// first thing worth telling the user about exists), plus where
    /// a tapped notification should land. The device token itself is
    /// kept only on this phone (UserDefaults) so sign-out can
    /// unregister exactly it; it is never part of synced state.
    var notificationPrimerVisible = false
    var pendingTaskOpenID: UUID?
    var highlightedOpportunityID: UUID?
    static let pushTokenKey = "hyggePushTokenV1"
    static let pushPrimerResolvedKey = "hyggePushPrimerResolvedV1"

    let backend = BackendClient()
    private let localRunner = SimulatedMissionRunner()

    /// True with a usable session token (Keychain, or a Debug
    /// developer token). Drives the launch sign-in gate (Brief 00).
    var isSignedIn = false

    init() {
        if !load() {
            opportunities = SampleData.opportunities
        }
        isSignedIn = backend.hasSessionToken
        visitMarker = lastVisitAt ?? .distantPast
        lastVisitAt = Date()
        // A token or a tap that arrives while running is drained
        // straight away; cold-launch arrivals wait in PushInbox for
        // the launch refresh in HyggeApp.
        PushInbox.onArrival = { [weak self] in
            Task { await self?.refreshPushState() }
        }
    }

    var pendingApprovalCount: Int { tasks.filter { $0.status == .awaitingApproval }.count }

    /// Live agent work: missions running plus interactive browser
    /// sessions. Drives the laptop flame — Hygge is at the keyboard.
    private(set) var activeRunCount = 0
    private(set) var liveBrowserSessionCount = 0
    var isAgentWorking: Bool { activeRunCount + liveBrowserSessionCount > 0 }

    func noteRunStarted() { activeRunCount += 1 }
    func noteRunFinished() { activeRunCount = max(0, activeRunCount - 1) }
    func noteBrowserSessionOpened() { liveBrowserSessionCount += 1 }
    func noteBrowserSessionClosed() { liveBrowserSessionCount = max(0, liveBrowserSessionCount - 1) }

    /// Demo listings are local-only colour until the first real item
    /// exists for this user (here or on another device); then they go.
    var visibleOpportunities: [Opportunity] {
        StateSync.visibleOpportunities(opportunities, serverHasReal: hasRealServerFeedItem)
    }

    /// Feed order is the server ranker's (Brief 06); MatchResult here
    /// is display evidence only.
    var rankedOpportunities: [(Opportunity, MatchResult)] {
        MatchEngine.inServerRankOrder(profile: profile,
                                      opportunities: visibleOpportunities.filter { $0.status != .dismissed })
    }

    // MARK: - Feedback recording (Brief 06)

    /// Append one decision and fold it into the local learning copy.
    /// The save()/push that follows at each call site carries it to
    /// the server, where the same events rebuild the ranking model.
    func recordFeedback(_ event: FeedbackEvent) {
        guard !feedbackEvents.contains(where: { $0.id == event.id }) else { return }
        feedbackEvents.append(event)
        learningProfile.apply(event)
    }

    /// For outcomes that must only ever be learned from once per
    /// subject (accepted / sent / booked / completed).
    func recordFeedbackOnce(_ event: FeedbackEvent) {
        guard !feedbackEvents.contains(where: {
            $0.subjectType == event.subjectType && $0.subjectId == event.subjectId && $0.action == event.action
        }) else { return }
        recordFeedback(event)
    }

    func site(id: String) -> TargetSite? { sites.first { $0.id == id } }
    func siteName(id: String) -> String { site(id: id)?.name ?? id }

    func credential(forDomain domain: String) -> CredentialRef? {
        credentialRefs.first { $0.domain == domain }
    }

    // MARK: - Identity (Brief 00)

    func refreshAuthState() {
        isSignedIn = backend.hasSessionToken
    }

    // MARK: - Push notifications (Brief 07)

    /// Something exists that would have been worth a push: a card
    /// waiting for the user, or real work found for them. This is
    /// the primer's one trigger — never first launch, never
    /// onboarding.
    private var hasNotifiableEvent: Bool {
        needsYouCount > 0 || hasRealServerFeedItem || opportunities.contains { !$0.isDemo }
    }

    func refreshNotificationPrimer() async {
        notificationPrimerVisible = NotificationPrimerPolicy.shouldShowPrimer(
            hasNotifiableEvent: hasNotifiableEvent,
            primerAlreadyResolved: UserDefaults.standard.bool(forKey: Self.pushPrimerResolvedKey),
            authorization: await PermissionService.notificationAuthorization(),
            isSignedIn: isSignedIn)
    }

    /// The primer's yes (also the profile hub's turn-on button for
    /// the still-undecided state). The primer is resolved either
    /// way: Hygge asks once and never nags.
    func allowNotifications() async {
        UserDefaults.standard.set(true, forKey: Self.pushPrimerResolvedKey)
        notificationPrimerVisible = false
        if await PermissionService.requestNotifications() {
            await refreshPushState()
        }
    }

    func dismissNotificationPrimer() {
        UserDefaults.standard.set(true, forKey: Self.pushPrimerResolvedKey)
        notificationPrimerVisible = false
    }

    /// Drain delegate arrivals, keep registration in step with the
    /// current permission answer, and refresh the primer. Called at
    /// launch and on every foregrounding; all of it is idempotent.
    func refreshPushState() async {
        if let route = PushInbox.pendingRoute {
            PushInbox.pendingRoute = nil
            await handlePushRoute(route)
        }
        if let token = PushInbox.pendingTokenHex {
            PushInbox.pendingTokenHex = nil
            if DeviceTokenEncoding.isPlausible(token) {
                UserDefaults.standard.set(token, forKey: Self.pushTokenKey)
            }
        }
        if isSignedIn, let token = UserDefaults.standard.string(forKey: Self.pushTokenKey) {
            switch await PermissionService.notificationAuthorization() {
            case .authorized:
                await backend.registerDeviceToken(token)
            case .denied:
                // Permission was taken away: stop sends to this phone.
                // The local copy is dropped only once the server row
                // is gone, so a failed unregister retries next launch.
                if await backend.unregisterDeviceToken(token) {
                    UserDefaults.standard.removeObject(forKey: Self.pushTokenKey)
                }
            case .notDetermined:
                break
            }
        }
        await refreshNotificationPrimer()
    }

    /// A tapped notification lands on fresh state, then on the item
    /// it named. Home is the only destination: a task opens its
    /// detail sheet; a feed item is highlighted at the top of the
    /// pinned zone's home feed (it was pulled just now).
    func handlePushRoute(_ route: String) async {
        await pullFromServer()
        switch PushDeepLink.parse(route: route) {
        case .task(let id):
            if tasks.contains(where: { $0.id == id }) {
                pendingTaskOpenID = id
            } else {
                lastMessage = "That one is already sorted. Everything waiting for you is below."
            }
        case .feedItem(let id):
            highlightedOpportunityID = id
            lastMessage = opportunities.contains { $0.id == id }
                ? "Here is the new work that just turned up."
                : "Fresh work is waiting in your feed below."
        case .home:
            break
        }
    }

    func signOut() async {
        // Brief 07: this phone stops getting this account's pushes.
        // Unregister while the session still works, then forget the
        // token here too. The next account gets its own one primer.
        if let token = UserDefaults.standard.string(forKey: Self.pushTokenKey),
           await backend.unregisterDeviceToken(token) {
            // Only forget it locally once the server row is gone;
            // otherwise the next sign-in re-registers (reassigns) it.
            UserDefaults.standard.removeObject(forKey: Self.pushTokenKey)
        }
        UserDefaults.standard.removeObject(forKey: Self.pushPrimerResolvedKey)
        PushInbox.pendingTokenHex = nil
        PushInbox.pendingRoute = nil
        notificationPrimerVisible = false
        pendingTaskOpenID = nil
        highlightedOpportunityID = nil
        await backend.signOut()
        isSignedIn = false
        // Wipe every per-user local trace: the next account on this
        // device must never see the previous account's cached feed,
        // profile, or beliefs, and must not inherit backend-first mode.
        pushTask?.cancel()
        pushTask = nil
        isBackendFirst = false
        UserDefaults.standard.removeObject(forKey: Self.backendFirstKey)
        hasRealServerFeedItem = false
        lastSyncError = nil
        pendingCredentialSave = nil
        sessionProfileRefs = []
        resetLocalState()
        if let url = storeURL { try? FileManager.default.removeItem(at: url) }
        writeCache()
        lastMessage = "Signed out. Your Hygge account is still there whenever you sign back in."
    }

    // MARK: - Onboarding

    func completeOnboarding(profile: EarningsProfile) {
        self.profile = profile
        hasOnboarded = true
        // Propose first. Nothing is signed up for until the user approves a
        // site; only then does the agent start figuring out that site.
        proposals = SiteProposals.generate(profile: profile, sites: sites)
        for proposal in proposals where accountStates[proposal.siteID] == nil {
            accountStates[proposal.siteID] = .proposed
        }
        lastMessage = "I've found \(proposals.count) places that fit you — starting with the one below. Say yes and I'll handle the signup from there."
        save()
    }

    /// The one pause switch. Everything user-facing goes through here so the
    /// state is always persisted and explained the same way.
    func setPaused(_ paused: Bool) {
        isPaused = paused
        lastMessage = paused
            ? "Paused. I won't search, send, or book until you resume."
            : "Back on. I'll tell you in the morning — sooner if something needs you."
        save()
    }

    func approveProposal(proposalID: UUID, alreadyHasAccount: Bool) {
        guard let index = proposals.firstIndex(where: { $0.id == proposalID }),
              let site = site(id: proposals[index].siteID) else { return }
        proposals[index].status = alreadyHasAccount ? .approvedHasAccount : .approvedSignup
        recordFeedback(FeedbackEvent(subjectType: .siteProposal,
                                     subjectId: proposalID.uuidString.lowercased(),
                                     action: .approved, category: site.category))
        accountStates[site.id] = .joining
        // Brief 04 email choice: a Hygge address the user chose in
        // the profile hub is used for new site signups (Hygge then
        // finishes email verification itself); otherwise the
        // signup confirms the user's own email from their profile.
        var task = alreadyHasAccount
            ? AgentTaskFactory.profileTask(profile: profile, site: site)
            : (hyggeEmailAddress.map {
                AgentTaskFactory.signupTask(profile: profile, site: site,
                                            emailChoice: .hygge, signupEmail: $0.address)
            } ?? AgentTaskFactory.signupTask(profile: profile, site: site))
        attachCredential(&task)
        attachSkill(&task)
        tasks.append(task)
        // "I already have a profile" is the moment to ask for the login:
        // present the save sheet first, then start the joining work with
        // whatever the user chose (saved login attached, or none).
        if alreadyHasAccount && credential(forDomain: site.domain) == nil {
            pendingCredentialSave = CredentialSaveRequest(
                siteID: site.id, siteName: site.name, domain: site.domain, taskID: task.id)
            lastMessage = "Save your \(site.name) login and I'll sign in for you from now on — or skip and I'll still take a look."
            save()
            return
        }
        lastMessage = "Joining \(site.name) — I'll work it out on the live site and only stop for things only you can do."
        save()
        // Consent was the approval: the joining mission starts now, with no
        // second generic approval. Unknowns/bot checks still come back.
        // While paused the mission is drafted but never started.
        if isPaused {
            lastMessage = "Saved for later — Hygge is paused, so joining \(site.name) will wait until you resume."
            return
        }
        let taskID = task.id
        Task { await approveAndRun(taskID: taskID) }
    }

    /// The save sheet closed (saved or skipped): attach any freshly
    /// saved login and start the work that was waiting on it.
    func finishCredentialSave(_ request: CredentialSaveRequest, saved: Bool) {
        if pendingCredentialSave?.id == request.id { pendingCredentialSave = nil }
        guard let taskID = request.taskID,
              let index = tasks.firstIndex(where: { $0.id == taskID }) else { save(); return }
        attachCredential(&tasks[index])
        save()
        if isPaused {
            lastMessage = "Saved for later — Hygge is paused, so joining \(request.siteName) will wait until you resume."
            return
        }
        Task { await approveAndRun(taskID: taskID) }
    }

    func dismissProposal(proposalID: UUID) {
        guard let index = proposals.firstIndex(where: { $0.id == proposalID }) else { return }
        proposals[index].status = .dismissed
        recordFeedback(FeedbackEvent(subjectType: .siteProposal,
                                     subjectId: proposalID.uuidString.lowercased(),
                                     action: .dismissed,
                                     category: site(id: proposals[index].siteID)?.category))
        save()
    }

    func findMoreProposals() {
        guard !isPaused else { lastMessage = "Hygge is paused — resume and I'll look for more places."; return }
        let blocked = Set(accountStates.filter { $0.value.blocksSuggestions }.keys)
        let known = Set(proposals.map(\.siteID)).union(blocked)
        let extra = SiteProposals.generate(profile: profile, sites: sites.filter { !known.contains($0.id) })
        proposals.append(contentsOf: extra)
        lastMessage = extra.isEmpty ? "No more sites to suggest right now — add any site by URL below." : "Added \(extra.count) more suggestion(s)."
        save()
    }

    /// Real listings extracted by a live discovery mission join the feed as
    /// non-demo opportunities (deduped by title+site).
    func addDiscoveredOpportunities(items: [String], task: AgentTask) {
        let category = site(id: task.siteID)?.category ?? .localGig
        for raw in items {
            let title = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard title.count >= 8,
                  !opportunities.contains(where: { $0.siteID == task.siteID && $0.title == title }) else { continue }
            opportunities.insert(Opportunity(
                siteID: task.siteID, title: title,
                summary: "Found live by your agent on \(siteName(id: task.siteID)). Open it to draft an application.",
                category: category, payLabel: "See listing", estimatedHourly: nil,
                locationLabel: profile.locationLabel.isEmpty ? "Remote / see listing" : profile.locationLabel,
                isRemote: false, requiredSkills: [], urlString: task.targetURLString,
                isDemo: false), at: 0)
        }
        lastMessage = "Your agent found live listings on \(siteName(id: task.siteID)) — they're at the top of your feed."
        save()
    }

    /// Ask the (live) backend to propose more sites with the LLM; new domains
    /// are added as user sites so proposals can reference them.
    func refreshProposalsFromBackend() async {
        guard !isPaused else { return }
        for category in profile.interests {
            guard let found = try? await backend.siteProposals(category: category, profile: profile) else { continue }
            for dto in found {
                guard let site = TargetSite.userAdded(name: dto.name, urlOrDomain: dto.url, category: category) else { continue }
                if accountStates[site.id]?.blocksSuggestions == true { continue }
                if !sites.contains(where: { $0.id == site.id }) { sites.append(site) }
                if !proposals.contains(where: { $0.siteID == site.id }) {
                    proposals.append(ProposedSite(siteID: site.id, rationale: dto.rationale))
                }
            }
        }
        save()
    }

    func answerInformation(taskID: UUID, answers: [String: String]) {
        guard let index = tasks.firstIndex(where: { $0.id == taskID }) else { return }
        for (question, answer) in answers where !answer.trimmingCharacters(in: .whitespaces).isEmpty {
            let key: String
            if question.lowercased().contains("phone") { key = "phone" }
            else if question.lowercased().contains("date of birth") { key = "dateOfBirth" }
            else { key = "answer:" + question }
            tasks[index].draftedPayload[key] = answer
        }
        tasks[index].informationRequests = []
        try? tasks[index].requestReapproval()
        save()
    }

    // MARK: - Sites & credentials

    func addSite(name: String, urlOrDomain: String, category: OpportunityCategory) {
        guard let site = TargetSite.userAdded(name: name, urlOrDomain: urlOrDomain, category: category) else {
            lastMessage = "That doesn't look like a valid site domain or URL."
            return
        }
        sites.removeAll { $0.id == site.id }
        sites.append(site)
        lastMessage = "Added \(site.name). Draft a browser task or open it in the cloud browser — the agent will learn this site as it goes."
        save()
    }

    /// The secret is sent once to the server vault; only the reference is kept.
    /// Returns false (with nothing stored anywhere) if saving failed.
    @discardableResult
    func addCredential(domain: String, username: String, secret: String) async -> Bool {
        let cleanDomain = domain.replacingOccurrences(of: "www.", with: "")
            .replacingOccurrences(of: "https://", with: "")
            .replacingOccurrences(of: "http://", with: "")
        do {
            let ref = try await backend.storeCredential(domain: cleanDomain, username: username, secret: secret)
            // One saved login per site: a re-save replaces the old one.
            for old in credentialRefs where old.domain == cleanDomain && old.id != ref.id {
                await backend.deleteCredential(id: old.id)
            }
            credentialRefs.removeAll { $0.domain == cleanDomain }
            credentialRefs.append(ref)
            lastMessage = "Login for \(cleanDomain) saved safely. This phone keeps no copy of the password."
            save()
            return true
        } catch {
            lastMessage = "That login could not be saved just now. Nothing was stored — please try again in a moment."
            save()
            return false
        }
    }

    /// Deletes one saved login. The site's trusted sign-in is separate
    /// and stays (forget it on its own if you want both gone).
    func deleteCredential(id: UUID) async {
        guard let ref = credentialRefs.first(where: { $0.id == id }) else { return }
        await backend.deleteCredential(id: ref.id)
        credentialRefs.removeAll { $0.id == ref.id }
        lastMessage = "Saved login for \(ref.domain) deleted. Hygge can no longer sign in there for you."
        save()
    }

    func sessionProfile(forDomain domain: String) -> SessionProfileRef? {
        sessionProfileRefs.first { $0.domain == domain }
    }

    func refreshSessionProfiles() async {
        if let profiles = try? await backend.sessionProfiles() {
            sessionProfileRefs = profiles
        }
    }

    func refreshHyggeEmail() async {
        if let address = try? await backend.hyggeEmailAddress() {
            hyggeEmailAddress = address
        }
        if let filed = try? await backend.filedEmail() {
            filedEmailSummaries = filed
        }
    }

    /// The moment the user chooses a Hygge address: allocated once
    /// by the backend, then shown only to them here for forwarding.
    func chooseHyggeEmailAddress() async {
        if let address = try? await backend.allocateHyggeEmailAddress() {
            hyggeEmailAddress = address
            lastMessage = "Your Hygge email address is ready. Hygge can now handle signup mail for you."
            save()
        }
    }

    /// Own-email path: the user confirms their own email for a site
    /// and a suggested site password. The password goes once to the
    /// safe store via the normal save-login path — nowhere else.
    func saveOwnEmailLogin(domain: String, email: String, secret: String) async -> Bool {
        await addCredential(domain: domain, username: HyggeAuth.normalizeEmail(email), secret: secret)
    }

    /// Forgets one trusted sign-in. The saved login is kept, so the
    /// next visit simply signs in with it again.
    func deleteSessionProfile(domain: String) async {
        await backend.deleteSessionProfile(domain: domain)
        sessionProfileRefs.removeAll { $0.domain == domain }
        lastMessage = "Trusted sign-in for \(domain) forgotten. Your saved login is still kept safely."
        save()
    }

    // MARK: - Opportunities & applications

    func setStatus(_ status: OpportunityStatus, for opportunityID: UUID) {
        guard let index = opportunities.firstIndex(where: { $0.id == opportunityID }) else { return }
        opportunities[index].status = status
        save()
    }

    func draftApplication(for opportunity: Opportunity) {
        var task = AgentTaskFactory.applyTask(profile: profile, opportunity: opportunity)
        attachCredential(&task)
        attachSkill(&task)
        tasks.append(task)
        if !applications.contains(where: { $0.opportunityID == opportunity.id }) {
            applications.append(ApplicationRecord(opportunityID: opportunity.id,
                                                  siteID: opportunity.siteID, title: opportunity.title))
        }
        lastMessage = "Browser task drafted with your cover letter. Approve it in Approvals to run it in the cloud browser."
        save()
    }

    func draftBookCalendar(for opportunity: Opportunity, when: Date) {
        tasks.append(AgentTaskFactory.bookCalendarTask(opportunity: opportunity, when: when))
        save()
    }

    func draftBrowserTask(site: TargetSite, goal: String, kind: AgentTaskKind = .discover) {
        var task = AgentTaskFactory.customTask(site: site, goal: goal, kind: kind)
        attachCredential(&task)
        attachSkill(&task)
        tasks.append(task)
        lastMessage = "Task drafted for \(site.name). The agent will explore it live from your goal; any memory hints are advisory."
        save()
    }

    func draftSignup(site: TargetSite) {
        var task = hyggeEmailAddress.map {
            AgentTaskFactory.signupTask(profile: profile, site: site,
                                        emailChoice: .hygge, signupEmail: $0.address)
        } ?? AgentTaskFactory.signupTask(profile: profile, site: site)
        attachCredential(&task)
        tasks.append(task)
        save()
    }

    func draftSiteProfile(site: TargetSite) {
        var task = AgentTaskFactory.profileTask(profile: profile, site: site)
        attachCredential(&task)
        attachSkill(&task)
        tasks.append(task)
        save()
    }

    func setApplicationStage(_ stage: ApplicationStage, applicationID: UUID) {
        guard let index = applications.firstIndex(where: { $0.id == applicationID }) else { return }
        let was = applications[index].stage
        applications[index].stage = stage
        if stage == .booked && was != .booked {
            recordEvent(ActivityEvent(kind: .booked, sentence: "Booked: \(applications[index].title).",
                                      detail: "Confirmed on \(siteName(id: applications[index].siteID)).",
                                      siteID: applications[index].siteID, applicationID: applicationID))
            recordFeedbackOnce(FeedbackEvent(
                subjectType: .application, subjectId: applicationID.uuidString.lowercased(),
                action: .booked,
                category: opportunities.first { $0.id == applications[index].opportunityID }?.category))
        }
        if stage == .completed && was != .completed {
            recordFeedbackOnce(FeedbackEvent(
                subjectType: .application, subjectId: applicationID.uuidString.lowercased(),
                action: .completed,
                category: opportunities.first { $0.id == applications[index].opportunityID }?.category))
        }
        if stage == .completed && was != .completed && applications[index].agreedGross == nil {
            // No witnessed amount: the journal records completion without money claims.
            recordEvent(ActivityEvent(kind: .workCompleted, sentence: "Done: \(applications[index].title).",
                                      detail: "Marked complete without a recorded amount, so it is not counted in earnings.",
                                      siteID: applications[index].siteID, applicationID: applicationID))
        }
        save()
    }

    /// The money moment: completion with the actual amount the user confirms.
    func completeWork(applicationID: UUID, grossAmount: Double) {
        guard let index = applications.firstIndex(where: { $0.id == applicationID }) else { return }
        applications[index].stage = .completed
        applications[index].agreedGross = grossAmount
        recordEvent(ActivityEvent(
            kind: .workCompleted,
            sentence: "Done: \(applications[index].title) — \(JournalBuilder.money(grossAmount, currencyCode: applications[index].currencyCode)).",
            detail: "Amount confirmed by you at completion.",
            siteID: applications[index].siteID, applicationID: applicationID,
            grossAmount: grossAmount, currencyCode: applications[index].currencyCode))
        recordFeedbackOnce(FeedbackEvent(
            subjectType: .application, subjectId: applicationID.uuidString.lowercased(),
            action: .completed,
            category: opportunities.first { $0.id == applications[index].opportunityID }?.category))
        save()
    }

    private func recordTaskEvent(_ task: AgentTask) {
        let site = siteName(id: task.siteID)
        let listings = opportunities.filter { $0.siteID == task.siteID && !$0.isDemo }.count
        switch task.kind {
        case .discover:
            let survey = MatchEngine.survey(profile: profile,
                                            opportunities: opportunities.filter { $0.siteID == task.siteID },
                                            siteID: task.siteID)
            searchEvidence.append(survey)
            let sentence = survey.listingsRead > 0
                ? "Checked \(site). \(survey.journalSentence)"
                : "Checked \(site) for new work."
            recordEvent(ActivityEvent(kind: .searchedSite, sentence: sentence,
                                      detail: task.log.suffix(2).joined(separator: " "),
                                      siteID: task.siteID, listingsChecked: max(survey.listingsRead, listings)))
        case .signup:
            recordEvent(ActivityEvent(kind: .joinedSite, sentence: "Set you up on \(site).", siteID: task.siteID))
            recordFeedbackOnce(FeedbackEvent(subjectType: .signup, subjectId: task.siteID,
                                             action: .signupApproved,
                                             category: self.site(id: task.siteID)?.category))
        case .buildProfile:
            recordEvent(ActivityEvent(kind: .profileLive, sentence: "Your \(site) profile is live.", siteID: task.siteID))
            recordFeedbackOnce(FeedbackEvent(subjectType: .signup, subjectId: task.siteID,
                                             action: .profileConfirmed,
                                             category: self.site(id: task.siteID)?.category))
        case .apply:
            if let oppID = task.opportunityID,
               let opp = opportunities.first(where: { $0.id == oppID }) {
                recordFeedbackOnce(FeedbackEvent(
                    subjectType: .opportunity, subjectId: oppID.uuidString.lowercased(),
                    action: .accepted, category: opp.category,
                    requiredSkills: opp.requiredSkills, estimatedHourly: opp.estimatedHourly,
                    distanceKm: opp.distanceKm))
            }
            if let app = applications.first(where: { $0.opportunityID == task.opportunityID }) {
                recordFeedbackOnce(FeedbackEvent(
                    subjectType: .application, subjectId: app.id.uuidString.lowercased(),
                    action: .sent,
                    category: opportunities.first { $0.id == task.opportunityID }?.category))
            }
            recordEvent(ActivityEvent(kind: .applicationSent,
                                      sentence: "Sent your application: \(task.title.replacingOccurrences(of: "Apply: ", with: "")).",
                                      siteID: task.siteID,
                                      applicationID: applications.first { $0.opportunityID == task.opportunityID }?.id))
        case .message:
            recordEvent(ActivityEvent(kind: .messageSent, sentence: "Sent a message on \(site), in your words.", siteID: task.siteID))
        case .bookCalendar:
            recordEvent(ActivityEvent(kind: .booked, sentence: "Booked \(task.title.replacingOccurrences(of: "Book: ", with: "")) in your calendar.", siteID: task.siteID))
        }
    }

    // MARK: - Approval gate, then cloud-browser run with learning

    @discardableResult
    func approveAndRun(taskID: UUID) async -> AgentTaskStatus? {
        guard !isPaused else { lastMessage = "Hygge is paused. Resume from your profile when you're ready."; return nil }
        guard let index = tasks.firstIndex(where: { $0.id == taskID }) else { return nil }
        noteRunStarted()
        defer { noteRunFinished() }
        var finalStatus: AgentTaskStatus?
        do {
            // A task paused at a human check resumes in its kept-open
            // session; one still waiting on answers must go through
            // answerInformation -> requestReapproval first.
            if tasks[index].status == .needsHuman && tasks[index].informationRequests.isEmpty {
                try tasks[index].resume()
            } else {
                try tasks[index].approve()
            }
            var task = tasks[index]

            if task.kind == .bookCalendar {
                task = try localRunner.run(task, repository: &siteMemory)
                if await CalendarService.book(payload: task.draftedPayload) {
                    task.log.append("Added to your calendar.")
                } else {
                    task.status = .needsHuman
                    task.log.append("Calendar permission not granted. Enable it for Hygge, then approve again.")
                }
            } else if let result = try? await backend.runTask(task: task) {
                task.browserTrace = result.browser_trace
                // Kept-open session for a human check; nil when done.
                task.browserSessionID = result.session_id
                task.informationRequests = result.information_requests ?? []
                task.log.append(contentsOf: result.log)
                task.status = AgentTaskStatus(rawValue: result.status) ?? .failed
                if task.status == .succeeded, task.kind == .discover,
                   let items = result.extracted_items, !items.isEmpty {
                    addDiscoveredOpportunities(items: items, task: task)
                }
                if task.status == .succeeded {
                    // Mirror the server-side learning in the on-device repository.
                    if let learned = siteMemory.learn(domain: task.domain, kind: task.kind.memoryKind,
                                                       trace: task.browserTrace,
                                                       extractedCount: result.extracted_items?.count ?? 0) {
                        task.memoryID = learned.id
                    }
                }
            } else if BackendClient.requireCloud {
                task.status = .failed
                task.log.append("I could not reach Hygge just now, so I left this one alone. Nothing was sent.")
            } else {
                task.log.append("Working offline for this one — I could not reach the live helper.")
                task = try localRunner.run(task, repository: &siteMemory)
            }

            if task.status == .succeeded {
                if task.kind == .signup { accountStates[task.siteID] = .hasAccount }
                if task.kind == .buildProfile { accountStates[task.siteID] = .watching }
                recordTaskEvent(task)
            }
            if task.kind == .apply, task.status == .succeeded, let oppID = task.opportunityID {
                if let appIndex = applications.firstIndex(where: { $0.opportunityID == oppID }) {
                    applications[appIndex].stage = .submitted
                }
                setStatus(.applied, for: oppID)
            }
            tasks[index] = task
            finalStatus = task.status
            if task.status == .needsHuman, task.kind == .signup {
                accountStates[task.siteID] = .needsVerification
            }
            lastMessage = task.status == .needsHuman ? "That step needs you — see the task log." : "Task finished: \(task.title)"
        } catch {
            lastMessage = "Could not run that task: \(error)"
        }
        save()
        // A run that ends needing the user is the other first-
        // notifiable-event moment for the primer.
        await refreshNotificationPrimer()
        return finalStatus
    }

    /// Approve a batch of identical drafts. Runs in order and STOPS at the
    /// first one that does not complete, reporting exactly where and why.
    func approveBatch(taskIDs: [UUID]) async {
        guard !isPaused else { lastMessage = "Hygge is paused. Resume from your profile when you're ready."; return }
        var sent = 0
        for taskID in taskIDs {
            guard let task = tasks.first(where: { $0.id == taskID }) else { continue }
            let status = await approveAndRun(taskID: taskID)
            if status == .succeeded {
                sent += 1
            } else {
                let why = status == .needsHuman ? "it needs something only you can do" : "it didn't go through"
                lastMessage = "Sent \(sent) of \(taskIDs.count). Stopped at “\(task.title)” — \(why). The rest are still waiting for your yes."
                save()
                return
            }
        }
        lastMessage = sent == taskIDs.count ? "All \(sent) sent." : "Sent \(sent) of \(taskIDs.count)."
        save()
    }

    /// "Not now" lands here with its reason (Brief 06): the reason was
    /// previously discarded; now it is recorded as a declined feedback
    /// event so future suggestions learn from it. Learning never
    /// changes the rate floor — a "too low" decline only feeds the
    /// review prompt in the profile hub.
    func reject(taskID: UUID, reason: String? = nil) {
        guard let index = tasks.firstIndex(where: { $0.id == taskID }) else { return }
        let task = tasks[index]
        try? tasks[index].reject()
        let opp = task.opportunityID.flatMap { id in opportunities.first { $0.id == id } }
        recordFeedback(FeedbackEvent(
            subjectType: .opportunity,
            subjectId: (task.opportunityID ?? taskID).uuidString.lowercased(),
            action: .declined, reason: FeedbackReason.from(uiString: reason),
            category: opp?.category ?? site(id: task.siteID)?.category,
            requiredSkills: opp?.requiredSkills ?? [],
            estimatedHourly: opp?.estimatedHourly, distanceKm: opp?.distanceKm))
        save()
    }

    func updatePayload(taskID: UUID, key: String, value: String) {
        guard let index = tasks.firstIndex(where: { $0.id == taskID }) else { return }
        tasks[index].draftedPayload[key] = value
        save()
    }

    func resetAll() {
        resetLocalState()
        save()
    }

    /// Fresh-install local state (demo content only). Shared by
    /// Start over and sign-out; callers decide how it is persisted.
    private func resetLocalState() {
        profile = EarningsProfile()
        hasOnboarded = false
        sites = SeedSites.all
        siteMemory = SiteMemoryRepository()
        credentialRefs = []
        opportunities = SampleData.opportunities
        tasks = []
        applications = []
        proposals = []
        accountStates = [:]
        chatTranscript = []
        activityEvents = []
        beliefs = BeliefBook()
        searchEvidence = []
        feedbackEvents = []
        learningProfile = LearningProfile()
        isPaused = false
    }

    private func attachCredential(_ task: inout AgentTask) {
        task.credentialRefID = credential(forDomain: task.domain)?.id
    }

    private func attachSkill(_ task: inout AgentTask) {
        // Advisory only: the mission still starts from its goal + the live page.
        task.memoryID = siteMemory.memory(domain: task.domain, kind: task.kind.memoryKind)?.id
    }

    // MARK: - Thread, journal, insights, site control

    func appendChat(fromAgent: Bool, text: String) {
        chatTranscript.append(ChatEntry(fromAgent: fromAgent, text: text))
        save()
    }

    var journalEntries: [JournalEntry] { JournalBuilder.entries(from: activityEvents) }

    func recordEvent(_ event: ActivityEvent) {
        activityEvents.append(event)
        save()
    }

    /// Urgent decisions only. Optional site suggestions never inflate this.
    var needsYouCount: Int {
        tasks.filter { $0.status == .awaitingApproval || $0.status == .needsHuman }.count
    }

    /// Value waiting in pending drafts, for the calm header number.
    var pendingValue: Double {
        var total = 0.0
        for task in tasks where task.status == .awaitingApproval {
            if let oppID = task.opportunityID,
               let opp = opportunities.first(where: { $0.id == oppID }),
               let amount = opp.estimatedGross { total += amount }
        }
        return total
    }

    /// Witnessed earnings only: completion events carrying a structured amount.
    var earningsGross: Double {
        activityEvents.filter { $0.kind == .workCompleted }.compactMap(\.grossAmount).reduce(0, +)
    }

    var timeSavedMinutes: Int {
        TimeSaved.estimatedMinutes(
            listingsRead: activityEvents.reduce(0) { $0 + $1.listingsChecked },
            draftsWritten: activityEvents.filter { [.applicationSent, .profileLive, .messageSent].contains($0.kind) }.count,
            searchRuns: activityEvents.filter { $0.kind == .searchedSite }.count)
    }

    func stopWatching(siteID: String) {
        accountStates[siteID] = .stopped
        lastMessage = "Stopped watching \(siteName(id: siteID)). I won't suggest or search it again unless you ask."
        save()
    }

    // MARK: - Beliefs (propose → confirm; never silent)

    func proposeBelief(sentence: String, source: Belief.Source, confidence: Double) {
        beliefs.propose(sentence: sentence, source: source, confidence: confidence)
        save()
    }
    func clearProfileSkills() { profile.skills = []; save() }
    func confirmBelief(id: UUID) { beliefs.confirm(proposalID: id); save() }
    func rejectBelief(id: UUID) {
        beliefs.reject(proposalID: id); save()
        deleteServerRow("beliefs", id: id)
    }
    func editBelief(id: UUID, sentence: String) { beliefs.edit(beliefID: id, sentence: sentence); save() }
    func deleteBelief(id: UUID) {
        beliefs.delete(beliefID: id); save()
        deleteServerRow("beliefs", id: id)
    }

    private func deleteServerRow(_ entityPath: String, id: UUID) {
        guard isBackendFirst else { return }
        let backend = self.backend
        Task { await backend.deleteStateRow(entityPath: entityPath, id: id.uuidString.lowercased()) }
    }

    /// Execute a confirmed (or confirmation-free) chat action and say what happened.
    func performChatAction(_ action: ChatAction) async -> String {
        switch action {
        case .pause:
            setPaused(true)
            return "Paused. I won't search, send, or book until you resume."
        case .resume:
            setPaused(false)
            return "Back on. I'll tell you in the morning — sooner if something needs you."
        case .stopSite(let siteID):
            stopWatching(siteID: siteID)
            return "Stopped watching \(siteName(id: siteID)). Nothing more will be searched or sent there."
        case .changeFloor(let floor):
            profile.hourlyRateFloor = floor
            save()
            return "Done — your lowest rate is now $\(Int(floor))/hr. Anything below it gets quietly dropped."
        case .approveFirst:
            guard let task = tasks.first(where: { $0.status == .awaitingApproval }) else {
                return "There's nothing waiting for your approval right now."
            }
            let status = await approveAndRun(taskID: task.id)
            return status == .succeeded
                ? "Done — “\(task.title)” is sent."
                : "That one needs a look first — it's waiting on your home screen."
        case .bookFirst:
            guard let task = tasks.first(where: { $0.status == .awaitingApproval && $0.kind == .bookCalendar }) else {
                return "There's no booking waiting right now."
            }
            let status = await approveAndRun(taskID: task.id)
            return status == .succeeded ? "Booked: \(task.title)." : "That booking needs a look — it's on your home screen."
        case .explainDropped:
            guard let latest = searchEvidence.last else {
                return "I haven't searched anywhere yet, so nothing has been skipped."
            }
            if latest.dropped.isEmpty {
                return "Nothing was skipped on the last look at \(siteName(id: latest.siteID)) — everything read met your floor or matched."
            }
            let lines = latest.dropped.prefix(5).map { "“\($0.title)” — \($0.reason)" }.joined(separator: "; ")
            return "On \(siteName(id: latest.siteID)) I skipped: \(lines)."
        }
    }

    /// Full reconciliation: credential, proposals, site memory, pending
    /// drafts, and future suggestions all end with the disconnect.
    func disconnect(siteID: String) async {
        guard let site = site(id: siteID) else { return }
        if let credential = credential(forDomain: site.domain) {
            await backend.deleteCredential(id: credential.id)
            credentialRefs.removeAll { $0.id == credential.id }
        }
        // Disconnect ends everything for the site, trusted sign-in too
        // (the separate per-item controls remain for partial removal).
        await backend.deleteSessionProfile(domain: site.domain)
        sessionProfileRefs.removeAll { $0.domain == site.domain }
        proposals.removeAll { $0.siteID == siteID }
        siteMemory.memories.removeAll { $0.domain == site.domain }
        for index in tasks.indices where tasks[index].siteID == siteID
            && (tasks[index].status == .awaitingApproval || tasks[index].status == .draft || tasks[index].status == .needsHuman) {
            try? tasks[index].reject()
        }
        accountStates[siteID] = .disconnected
        lastMessage = "Disconnected \(site.name). Saved login deleted, drafts cleared, and I won't suggest it again."
        save()
    }

    /// Plain-language context the conversation model may use (never secrets).
    var conversationContextSummary: String {
        let journal = journalEntries.prefix(5).map(\.sentence).joined(separator: " ")
        return "Needs-you cards waiting: \(needsYouCount). Paused: \(isPaused). Approved sites: \(accountStates.filter { $0.value == .hasAccount || $0.value.isWatching }.keys.joined(separator: ", ")). Recent journal: \(journal)"
    }

    // MARK: - Server sync (Brief 01)
    //
    // Pull on launch and on foregrounding; push writes straight away
    // (briefly debounced so a burst of edits is one round-trip). The
    // push reuses the idempotent import: rows key by id, demo items
    // are excluded by construction, and the newest write wins. If a
    // push cannot get through, the change stays in the cache and
    // `lastSyncError` says so plainly — it is never reported as saved.

    func currentImport() -> ServerImport {
        ServerImport(profile: profile, hasOnboarded: hasOnboarded, isPaused: isPaused,
                     lastVisitAt: lastVisitAt, sites: sites, siteMemory: siteMemory,
                     credentialRefs: credentialRefs, opportunities: opportunities, tasks: tasks,
                     applications: applications, proposals: proposals, accountStates: accountStates,
                     chatTranscript: chatTranscript, activityEvents: activityEvents,
                     beliefs: beliefs, searchEvidence: searchEvidence,
                     feedbackEvents: feedbackEvents)
    }

    /// Launch entry point: migrate once if needed, otherwise pull.
    /// Any failure leaves the cache exactly as it was.
    func syncOnLaunch() async {
        guard !isSyncing else { return }
        if isBackendFirst {
            await pullFromServer()
            return
        }
        isSyncing = true
        do {
            let counts = try await backend.stateCounts()
            if counts.total > 0 {
                // Already migrated (or a second device): adopt, don't overwrite.
                markBackendFirst(hasReal: counts.hasRealFeedItem)
            } else {
                let payload = currentImport()
                let result = try await backend.importState(payload)
                let mismatches = StateSync.importMismatches(
                    expected: StateSync.expectedImportCounts(payload), serverCounts: result.counts)
                guard mismatches.isEmpty else { isSyncing = false; return }
                markBackendFirst(hasReal: result.hasRealFeedItem)
            }
        } catch {
            isSyncing = false
            return // Unreachable or not signed in yet: cache serves, retry next launch.
        }
        isSyncing = false
        await pullFromServer()
    }

    private func markBackendFirst(hasReal: Bool) {
        isBackendFirst = true
        hasRealServerFeedItem = hasReal
        UserDefaults.standard.set(true, forKey: Self.backendFirstKey)
    }

    /// Foreground/launch pull: server state replaces the cache (local
    /// demo listings survive until a real item hides them; drafts in
    /// `tasks` are untouched — live task records keep their own flow).
    func pullFromServer() async {
        guard isBackendFirst, !isSyncing else { return }
        isSyncing = true
        defer { isSyncing = false }
        guard let export = try? await backend.exportState() else { return }
        applyServerExport(export)
        if let refs = try? await backend.listCredentialRefs() { credentialRefs = refs }
        if let memory = try? await backend.listSiteMemory(), !memory.memories.isEmpty {
            siteMemory = memory
        }
        writeCache()
        // A pull can be the moment the first notifiable thing
        // exists (a scan found work while the app was closed).
        await refreshNotificationPrimer()
    }

    func applyServerExport(_ export: ServerExport) {
        if let state = export.profile?.data {
            profile = state.profile
            hasOnboarded = state.hasOnboarded
            isPaused = state.isPaused
            if lastVisitAt == nil { lastVisitAt = state.lastVisitAt }
        }
        if !export.sites.isEmpty { sites = export.sites.map(\.data) }
        let serverOpportunities = export.opportunities.map(\.data)
        if !serverOpportunities.isEmpty || export.hasRealFeedItem {
            let serverIDs = Set(serverOpportunities.map { $0.id.uuidString.lowercased() })
            let localDemo = opportunities.filter { $0.isDemo && !serverIDs.contains($0.id.uuidString.lowercased()) }
            opportunities = serverOpportunities + localDemo
        }
        chatTranscript = export.messages.map(\.data).sorted { $0.createdAt < $1.createdAt }
        applications = export.applications.map(\.data)
        proposals = export.proposals.map(\.data)
        accountStates = export.accountStates
        activityEvents = export.journalEvents.map(\.data)
        searchEvidence = export.searchEvidence.map(\.data)
        if !export.beliefRows.isEmpty {
            var book = BeliefBook()
            for row in export.beliefRows {
                if row.data.pending { book.pending.append(row.data.belief) }
                else { book.beliefs.append(row.data.belief) }
            }
            beliefs = book
        } else {
            beliefs = export.beliefs
        }
        beliefs.pruneExpired(at: Date())
        // Brief 06: the server is the learning truth. Adopt its events
        // and derived profile (rebuilding locally only when the server
        // has no derived row yet).
        if !export.feedbackEvents.isEmpty { feedbackEvents = export.feedbackEvents.map(\.data) }
        learningProfile = export.learningProfiles.first?.data ?? LearningProfile.rebuilt(from: feedbackEvents)
        hasRealServerFeedItem = export.hasRealFeedItem
    }

    private func schedulePush() {
        guard isBackendFirst else { return }
        pushTask?.cancel()
        pushTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            await self?.pushStateNow()
        }
    }

    private func pushStateNow() async {
        do {
            let result = try await backend.importState(currentImport())
            hasRealServerFeedItem = result.hasRealFeedItem
            lastSyncError = nil
        } catch {
            let outcome = OfflineWritePolicy.outcome(reachable: false, requireCloud: BackendClient.requireCloud)
            if outcome == .failedUnreachable {
                lastSyncError = "Couldn't reach Hygge just now, so that last change is only on this phone for now. It hasn't been saved anywhere else yet."
                lastMessage = lastSyncError
            } else {
                lastSyncError = "You're offline, so that last change is only on this phone for now."
            }
        }
    }

    // MARK: - Persistence

    private var storeURL: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("hygge.json")
    }

    /// Every local change lands in the cache, then pushes (Brief 01).
    private func save() {
        writeCache()
        schedulePush()
    }

    private func writeCache() {
        guard let url = storeURL else { return }
        let snapshot = StoreSnapshot(profile: profile, hasOnboarded: hasOnboarded, sites: sites,
                                     siteMemory: siteMemory, credentialRefs: credentialRefs,
                                     opportunities: opportunities, tasks: tasks, applications: applications,
                                     proposals: proposals, accountStates: accountStates,
                                     chatTranscript: chatTranscript, activityEvents: activityEvents, isPaused: isPaused, lastVisitAt: lastVisitAt, beliefs: beliefs, searchEvidence: searchEvidence, feedbackEvents: feedbackEvents, learningProfile: learningProfile)
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }

    private func load() -> Bool {
        guard let url = storeURL, let data = try? Data(contentsOf: url),
              let snapshot = try? JSONDecoder().decode(StoreSnapshot.self, from: data) else { return false }
        profile = snapshot.profile
        hasOnboarded = snapshot.hasOnboarded
        sites = snapshot.sites
        siteMemory = snapshot.siteMemory
        credentialRefs = snapshot.credentialRefs
        opportunities = snapshot.opportunities
        tasks = snapshot.tasks
        applications = snapshot.applications
        proposals = snapshot.proposals
        accountStates = snapshot.accountStates
        chatTranscript = snapshot.chatTranscript
        activityEvents = snapshot.activityEvents
        isPaused = snapshot.isPaused
        beliefs = snapshot.beliefs
        searchEvidence = snapshot.searchEvidence
        feedbackEvents = snapshot.feedbackEvents
        learningProfile = snapshot.learningProfile
        lastVisitAt = snapshot.lastVisitAt
        return true
    }
}
