import Foundation
import Observation

struct StoreSnapshot: Codable {
    init(profile: EarningsProfile, hasOnboarded: Bool, sites: [TargetSite],
         siteMemory: SiteMemoryRepository, credentialRefs: [CredentialRef],
         opportunities: [Opportunity], tasks: [AgentTask], applications: [ApplicationRecord],
         proposals: [ProposedSite], accountStates: [String: SiteAccountState],
         chatTranscript: [ChatEntry], activityEvents: [ActivityEvent], isPaused: Bool,
         lastVisitAt: Date?, beliefs: BeliefBook = BeliefBook(), searchEvidence: [SearchEvidence] = [],
         feedbackEvents: [FeedbackEvent] = [], learningProfile: LearningProfile = LearningProfile(),
         clearedHelpIDs: Set<UUID> = [], lastConversationGeneration: String? = nil) {
        self.profile = profile; self.hasOnboarded = hasOnboarded; self.sites = sites
        self.siteMemory = siteMemory; self.credentialRefs = credentialRefs
        self.opportunities = opportunities; self.tasks = tasks; self.applications = applications
        self.proposals = proposals; self.accountStates = accountStates
        self.chatTranscript = chatTranscript; self.activityEvents = activityEvents
        self.isPaused = isPaused; self.lastVisitAt = lastVisitAt
        self.beliefs = beliefs; self.searchEvidence = searchEvidence
        self.feedbackEvents = feedbackEvents; self.learningProfile = learningProfile
        self.clearedHelpIDs = clearedHelpIDs; self.lastConversationGeneration = lastConversationGeneration
    }
    var profile: EarningsProfile
    var profilePhotoData: Data? = nil
    var profilePhotoNeedsUpload = false
    var profilePhotoIsLegacy = false
    var pendingProfileEdit: Bool = false
    var archivedFeedIDs: Set<String> = []
    /// Tasks the person explicitly brought into chat by swiping a feed
    /// card to discuss it. Only these get a browser embedded in chat;
    /// a help request from Hygge never embeds one on its own.
    var discussedTaskIDs: Set<UUID> = []
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
    var pendingConversationMessageID: UUID? = nil
    var pendingConversationGeneration: String? = nil
    var conversationNeedsReconciliation: Bool = false
    /// Help ids cleared with a conversation reset (see
    /// noteConversationGeneration): synthesis skips these until the
    /// user taps the help back into chat or its situation changes.
    var clearedHelpIDs: Set<UUID> = []
    /// Last conversation generation seen from the server. A new one
    /// means the thread was cleared (reset).
    var lastConversationGeneration: String? = nil
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
        profilePhotoData = try c.decodeIfPresent(Data.self, forKey: .profilePhotoData)
        profilePhotoNeedsUpload = try c.decodeIfPresent(Bool.self, forKey: .profilePhotoNeedsUpload) ?? (profilePhotoData != nil)
        profilePhotoIsLegacy = try c.decodeIfPresent(Bool.self, forKey: .profilePhotoIsLegacy) ?? (profilePhotoData != nil)
        pendingProfileEdit = try c.decodeIfPresent(Bool.self, forKey: .pendingProfileEdit) ?? false
        archivedFeedIDs = try c.decodeIfPresent(Set<String>.self, forKey: .archivedFeedIDs) ?? []
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
        pendingConversationMessageID = try c.decodeIfPresent(UUID.self, forKey: .pendingConversationMessageID)
        pendingConversationGeneration = try c.decodeIfPresent(String.self, forKey: .pendingConversationGeneration)
        conversationNeedsReconciliation = try c.decodeIfPresent(Bool.self, forKey: .conversationNeedsReconciliation) ?? false
        clearedHelpIDs = try c.decodeIfPresent(Set<UUID>.self, forKey: .clearedHelpIDs) ?? []
        lastConversationGeneration = try c.decodeIfPresent(String.self, forKey: .lastConversationGeneration)
        activityEvents = try c.decodeIfPresent([ActivityEvent].self, forKey: .activityEvents) ?? []
        isPaused = try c.decodeIfPresent(Bool.self, forKey: .isPaused) ?? false
        lastVisitAt = try c.decodeIfPresent(Date.self, forKey: .lastVisitAt)
        beliefs = try c.decodeIfPresent(BeliefBook.self, forKey: .beliefs) ?? BeliefBook()
        searchEvidence = try c.decodeIfPresent([SearchEvidence].self, forKey: .searchEvidence) ?? []
        feedbackEvents = try c.decodeIfPresent([FeedbackEvent].self, forKey: .feedbackEvents) ?? []
        learningProfile = try c.decodeIfPresent(LearningProfile.self, forKey: .learningProfile) ?? LearningProfile()
    }
}

@MainActor
@Observable
final class AppStore {
    var archivedFeedIDs: Set<String> = []
    /// Tasks the person explicitly brought into chat by swiping a feed
    /// card to discuss it. Only these get a browser embedded in chat.
    var discussedTaskIDs: Set<UUID> = []
    var profile = EarningsProfile()
    // Server-owned photo with an offline cache and durable pending upload.
    var profilePhotoData: Data?
    private(set) var profilePhotoNeedsUpload = false
    private var profilePhotoIsLegacy = false
    private(set) var profilePhotoSyncError: String?
    private(set) var isSyncingProfilePhoto = false
    private var profilePhotoRevision = 0
    private var profilePhotoAccountEpoch = 0
    @ObservationIgnored private var photoSyncTask: Task<Void, Never>?
    private(set) var pendingProfileEdit = false
    private var profileEditRevision = 0
    var hasOnboarded = false
    var sites: [TargetSite] = SeedSites.all
    var siteMemory = SiteMemoryRepository()
    var credentialRefs: [CredentialRef] = []
    var opportunities: [Opportunity] = []
    var tasks: [AgentTask] = []
    private var runningTaskIDs: Set<UUID> = []
    var conversationTaskID: UUID?
    /// The feed card attached to the next chat message
    /// ("Chat about this"). Session-only; stamped onto the
    /// entry when sent, then cleared.
    var pendingChatContext: ChatContextRef?
    var dismissedProposalID: UUID?
    var applications: [ApplicationRecord] = []
    var proposals: [ProposedSite] = []
    var accountStates: [String: SiteAccountState] = [:]
    var chatTranscript: [ChatEntry] = []
    private(set) var pendingConversationMessageID: UUID?
    private(set) var conversationNeedsReconciliation = false
    private(set) var pendingConversationGeneration: String?
    /// When the user last actually read the thread, on this
    /// device. Drives the flame badge — which must only promise
    /// what opening the chat can resolve.
    private(set) var chatLastReadAt: Date = UserDefaults.standard.object(forKey: "hygge.chatLastReadAt") as? Date ?? .distantPast {
        didSet { UserDefaults.standard.set(chatLastReadAt, forKey: "hygge.chatLastReadAt") }
    }
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
    /// Durable on-device memory that an account has been signed
    /// into on this phone at least once. Survives sign-out on
    /// purpose: it is what sends a signed-out launch straight to
    /// the log in page instead of the new-user onboarding.
    static let hasSignedInBeforeKey = "hyggeHasSignedInBeforeV1"
    var hasSignedInBefore: Bool { UserDefaults.standard.bool(forKey: Self.hasSignedInBeforeKey) }
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
    var emailNextCursor: String?
    var emailRefreshError: String?
    var emailHasLoaded = false
    var refreshingEmail = false
    var loadingOlderEmail = false
    var ownEmailAddresses: [OwnEmailAddress] = []
    /// Senders the user opted out of evaluation (silent filing).
    /// The only remembered sender rule the app surfaces.
    var ignoredSenderDomains: [String] = []

    /// Brief 07 push: the one-time Home primer (shown only after the
    /// first thing worth telling the user about exists), plus where
    /// a tapped notification should land. The device token itself is
    /// kept only on this phone (UserDefaults) so sign-out can
    /// unregister exactly it; it is never part of synced state.
    var notificationPrimerVisible = false
    var pendingTaskOpenID: UUID?
    var pendingOpportunityOpenID: UUID?
    var pendingEmailOpenID: UUID?
    /// A chat card tapped in the conversation: the feed card it is
    /// about, opened as a feed focus (not as chat).
    var pendingTaskFocusOpenID: UUID?
    /// A chat card tapped in the conversation for a site proposal or
    /// a journal event: the feed card it is about, opened as a feed
    /// focus (the proposal id / the event id).
    var pendingProposalOpenID: UUID?
    var pendingEventOpenID: UUID?
    /// A tapped new-work push: the chat message it names — open the
    /// bare conversation, no task attached.
    var pendingChatOpenID: UUID?
    /// The message a tapped new-work push names, once it is verified
    /// to be in the transcript: the conversation scrolls to it.
    var pendingChatMessageID: UUID?
    var highlightedOpportunityID: UUID?
    /// Help ids cleared with a conversation reset (see
    /// noteConversationGeneration). Synthesis skips these until the
    /// user taps the help back into chat or its situation changes.
    /// Persisted: a reset observed on one launch must still hold
    /// after a relaunch.
    var clearedHelpIDs: Set<UUID> = []
    /// Last conversation generation seen from the server. A new one
    /// means the thread was cleared (reset).
    private(set) var lastConversationGeneration: String?
    /// Bumped whenever a routing fallback writes lastMessage, so
    /// Home can bring the note into view (scroll to top, close the
    /// chat bubble first). Session-only.
    var routingNoteRevision = 0
    /// A chat card about the notifications primer: open the
    /// notifications surface once Home has closed what is open.
    var pendingNotificationsOpen = false
    static let pushTokenKey = "hyggePushTokenV1"
    static let pushPrimerResolvedKey = "hyggePushPrimerResolvedV1"

    let backend = BackendClient()
    /// Hygge Plus entitlement (StoreKit). Started in init; the
    /// device's verified reading is what the plan gates use.
    let plusStore = PlusStore()
    private let localRunner = SimulatedMissionRunner()

    /// The plan, read fresh from witnessed facts every time —
    /// never stored. Gates below and the Profile card share it.
    var plan: PlanSnapshot {
        PlanSnapshot.make(tier: plusStore.isPlus ? .plus : .free,
                          events: activityEvents, states: accountStates, now: Date())
    }

    /// The honest sentence for why new work is pausing, when it is.
    var planRestMessage: String {
        let when = plan.restartsAt.formatted(.dateTime.month(.wide).day())
        return "I'm resting until \(when). You've passed the free $100 of earnings this month, so new searches and applications pause. Work already under way carries on."
    }

    var planSiteCapMessage: String {
        "I'm already watching \(Plan.freeSiteLimit) job sites, which is the free plan's limit. Stop one to make room, or see Plus in your profile."
    }

    var canJoinAnotherSite: Bool {
        Plan.canManageAnotherSite(tier: plan.tier, managedSites: plan.managedSites)
    }

    /// True with a usable session token (Keychain, or a Debug
    /// developer token). Drives the launch sign-in gate (Brief 00).
    var isSignedIn = false
    var isExistingAccount = false
    private(set) var isCompletingSignIn = false

    init() {
        if !load() {
            opportunities = SampleData.opportunities
        }
        isSignedIn = backend.hasSessionToken
        isExistingAccount = isSignedIn && !backend.sessionIsNewUser && hasOnboarded
        visitMarker = lastVisitAt ?? .distantPast
        lastVisitAt = Date()
        // A token or a tap that arrives while running is drained
        // straight away; cold-launch arrivals wait in PushInbox for
        // the launch refresh in HyggeApp.
        PushInbox.onArrival = { [weak self] in
            Task { await self?.refreshPushState() }
        }
        plusStore.reportTransaction = { [backend] jws in
            _ = await backend.reportSubscription(jws: jws)
        }
        plusStore.start()
    }

    var pendingApprovalCount: Int { tasks.filter { $0.status == .awaitingApproval }.count }

    /// Live agent work: missions running plus interactive browser
    /// sessions. Drives the laptop flame — Hygge is at the keyboard.
    private(set) var activeRunCount = 0
    private(set) var liveBrowserSessionCount = 0
    var isAgentWorking: Bool { activeRunCount > 0 || tasks.contains { $0.status == .running || $0.status == .approved } }
    /// A browser session is being kept open for a task that is still
    /// live: a running or approved run, or a human check waiting on
    /// the person (the backend returns a nil session id once a session
    /// closes). A paused run (recovery help) or a finished task is
    /// not an active run, even if its session id is still present —
    /// a blocked or failed session must not hold the laptop on.
    /// Drives the laptop on both flames.
    var hasActiveBrowserSession: Bool {
        tasks.contains {
            $0.browserSessionID != nil
            && $0.status != .succeeded && $0.status != .failed && $0.status != .rejected
            && $0.help?.kind != .recovery
        }
    }

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
    func siteDomain(id: String) -> String? { site(id: id)?.domain }

    func credential(forDomain domain: String) -> CredentialRef? {
        credentialRefs.first { $0.domain == domain }
    }

    // MARK: - Identity

    /// The one emailed-link flow (MagicLinkFlow.swift). Tokens
    /// themselves are never stored here — a tapped link is
    /// consumed immediately, in place.
    var magicLinkFlow: MagicLinkFlowState?
    /// Onboarding answers handed over when the sign-up link was
    /// sent, so consuming it anywhere (cold launch included) can
    /// still finish onboarding with them. Cleared once imported.
    var pendingOnboardingProfile: EarningsProfile?
    var magicConsumeInFlight = false
    var passwordFlow: PasswordConfirmationState?
    var isShowingLogins = false
    var isShowingProfile = false
    /// One calm sentence when a tapped link no longer works.
    var magicLinkError: String?
    /// "I already have an account": show the sign-in message alone.
    var wantsSignIn = false
    /// Session-only: "Sign up" tapped on the log in page.
    var wantsOnboarding = false
    /// Session-only: the carousel was finished this launch.
    /// "Sign up" resets it so onboarding starts at page one.
    var introDone = false

    func refreshAuthState() {
        isSignedIn = backend.hasSessionToken
        isExistingAccount = isSignedIn && !backend.sessionIsNewUser && hasOnboarded
        // Any live session (including one from a build predating
        // this flag) proves a previous sign-in on this phone.
        if isSignedIn { UserDefaults.standard.set(true, forKey: Self.hasSignedInBeforeKey) }
    }

    /// Universal-link and hygge:// entry: consume the token in
    /// place under the purpose that sent it. Deliberately does
    /// NOT steer routing — swapping screens here once destroyed
    /// an in-progress onboarding (and its answers) and restarted
    /// the chat after a successful sign-up.
    func handleMagicURL(_ url: URL) -> Bool {
        guard let token = MagicLink.token(from: url) else { return false }
        if MagicLink.isPasswordConfirmation(url) {
            Task { await finishPasswordConfirmation(token: token) }
            return true
        }
        Task { await consumeMagicToken(token) }
        return true
    }

    /// Called right after a verified sign-in (Apple or a consumed
    /// magic link). `localProfile` carries the onboarding answers
    /// collected on this device before the account existed. The
    /// decision itself is HyggeCore's SignInCompletion: an onboarded
    /// server account is adopted as-is (the local snapshot is never
    /// imported over it); a fresh account imports the local answers
    /// exactly once via the existing first-sign-in migration.
    /// `hasOnboarded` only ever flips true from here.
    func finishSignIn(localProfile: EarningsProfile? = nil) async {
        guard !isCompletingSignIn else { return }
        isCompletingSignIn = true
        var accountLoaded = false
        defer {
            isCompletingSignIn = false
            if accountLoaded {
                refreshAuthState()
                wantsSignIn = false
                wantsOnboarding = false
                pendingOnboardingProfile = nil
            }
        }
        // Keep the sign-in view mounted until adoption finishes. In particular,
        // do not publish isSignedIn while hasOnboarded is still the cleared cache.
        while isSyncing {
            guard !Task.isCancelled else { return }
            try? await Task.sleep(for: .milliseconds(50))
        }
        magicLinkError = nil
        // Identity safety: if the session just issued belongs to a
        // different account than the one cached on this device, the
        // local snapshot is the previous account's and nothing from
        // it may be imported or pushed. Onboarding answers handed
        // in by this run of the flow are the one exception — they
        // belong to the person who just answered them.
        let differentAccount = AccountSessionTransition.requiresAdoption(wasSignedIn: true,
            previousUserID: backend.previousSessionUserID, nextUserID: backend.sessionUserID)
        if differentAccount {
            pushTask?.cancel()
            pushTask = nil
            isBackendFirst = false
            UserDefaults.standard.removeObject(forKey: Self.backendFirstKey)
            hasRealServerFeedItem = false
            pendingCredentialSave = nil
            sessionProfileRefs = []
            resetLocalState()
            if let url = storeURL { try? FileManager.default.removeItem(at: url) }
            writeCache()
        }
        let answers = localProfile ?? pendingOnboardingProfile ?? profile
        let localComplete = answers.isComplete
        // The account probe is part of finishing: if it cannot run,
        // stay on the sign-in step with a clear message rather than
        // completing onboarding from the local cache and pushing it
        // over an unseen server account.
        guard let counts = try? await backend.stateCounts() else {
            magicLinkError = "You're signed in, but your account wouldn't load just now. Try your sign-in again in a moment."
            return
        }
        if counts.total > 0 {
            // The account already lives on the server: adopt first,
            // decide from its real profile. A failed pull decides
            // nothing — never fall back to the local copy.
            markBackendFirst(hasReal: counts.hasRealFeedItem)
            guard await pullFromServer() else {
                magicLinkError = "You're signed in, but your account wouldn't load just now. Try your sign-in again in a moment."
                return
            }
            accountLoaded = true
            if !backend.sessionIsNewUser { return }
            switch SignInCompletion.decide(serverHasState: true,
                                           serverHasOnboarded: hasOnboarded,
                                           localProfileComplete: localComplete) {
            case .adoptServerState:
                return // straight Home on the account's own state
            case .completeOnboardingAndImport:
                completeOnboarding(profile: answers)
                return
            case .continueOnboarding:
                return
            }
        }
        if !backend.sessionIsNewUser {
            // A returning identity with no server state is not an onboarded
            // account yet — it is the stranded case (signup created the
            // account but onboarding never ran, e.g. the first sign-in
            // failed after the server issued a session). Never import a
            // previous account's cached answers, but answers handed in by
            // this run are this account's own: complete onboarding with
            // them and import once. Without complete answers, reset to a
            // clean slate and let routing send the user to onboarding
            // instead of an empty Home — isExistingAccount now requires
            // hasOnboarded, so a non-onboarded account routes there.
            // In both cases stay out of backend-first mode: the server
            // is empty, so a later import must actually import, not pull
            // the empty state over freshly completed onboarding.
            isBackendFirst = false
            UserDefaults.standard.removeObject(forKey: Self.backendFirstKey)
            if localComplete {
                completeOnboarding(profile: answers)
                await syncOnLaunch(finishingSignIn: true)
            } else {
                resetLocalState()
                writeCache()
            }
            accountLoaded = true
            return
        }
        // Fresh account: finish locally when the answers are
        // complete, then run the one-time import, which itself
        // refuses to overwrite a server that already has state.
        if localComplete {
            completeOnboarding(profile: answers)
        }
        await syncOnLaunch(finishingSignIn: true)
        accountLoaded = true
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

    func undoNotificationDismissal() {
        UserDefaults.standard.set(false, forKey: Self.pushPrimerResolvedKey)
        notificationPrimerVisible = true
    }

    /// Drain delegate arrivals, keep registration in step with the
    /// current permission answer, and refresh the primer. Called at
    /// launch and on every foregrounding; all of it is idempotent.
    func refreshPushState() async {
        if let route = PushInbox.pendingRoute {
            PushInbox.pendingRoute = nil
            await handlePushRoute(route)
        }
        if PushInbox.pendingForegroundDelivery {
            PushInbox.pendingForegroundDelivery = false
            // A push landed while the app was open: pull now so its
            // message is visible (flame badge + transcript) instead
            // of waiting for the next scheduled pull. A pull already
            // in flight returns false here and lands it itself.
            await pullFromServer()
        }
        if let token = PushInbox.pendingTokenHex {
            PushInbox.pendingTokenHex = nil
            if DeviceTokenEncoding.isPlausible(token) {
                UserDefaults.standard.set(token, forKey: Self.pushTokenKey)
            }
        }
        if isSignedIn {
            switch await PermissionService.notificationAuthorization() {
            case .authorized:
                // Re-ask iOS for the token even when we hold none
                // locally (sign-out, reinstall, Settings grant): the
                // delegate callback is the only token source, and
                // without this call it never fires again.
                PermissionService.registerForRemoteNotifications()
                if let token = UserDefaults.standard.string(forKey: Self.pushTokenKey) {
                    await backend.registerDeviceToken(token)
                }
            case .denied:
                // Permission was taken away: stop sends to this phone.
                // The local copy is dropped only once the server row
                // is gone, so a failed unregister retries next launch.
                if let token = UserDefaults.standard.string(forKey: Self.pushTokenKey),
                   await backend.unregisterDeviceToken(token) {
                    UserDefaults.standard.removeObject(forKey: Self.pushTokenKey)
                }
            case .notDetermined:
                break
            }
        }
        await refreshNotificationPrimer()
    }

    /// A routing fallback has something to say on Home: set the
    /// one-line note and bump the revision HomeFeedView watches to
    /// bring it into view — the feed scrolls to the top and an open
    /// chat bubble closes first, so the note is never left
    /// off-screen or hidden behind the bubble.
    func setRoutingNote(_ message: String) {
        lastMessage = message
        routingNoteRevision += 1
    }

    /// A tapped notification lands on fresh state, then opens the
    /// exact element it named: the task's chat card, the listing's
    /// own detail, or that one filed mail. If the element is gone
    /// (handled elsewhere, dismissed), Home says so in one line —
    /// never a wrong element silently substituted.
    func handlePushRoute(_ route: String) async {
        // A pull already in flight will land the message
        // imminently: wait for it instead of reporting a false
        // "couldn't reach". (Same capped wait as refreshFeed; a
        // stuck pull still falls through to a fresh attempt.)
        var waits = 0
        while isSyncing, waits < 100 {
            guard !Task.isCancelled else { return }
            try? await Task.sleep(for: .milliseconds(100))
            waits += 1
        }
        // The pull's result matters: a failed pull leaves the last
        // known transcript in place, so a missing message after a
        // failed pull is "unconfirmed", not "gone".
        let pulled = await pullFromServer()
        switch PushDeepLink.parse(route: route) {
        case .task(let id):
            if tasks.contains(where: { $0.id == id }) {
                pendingTaskOpenID = id
            } else {
                setRoutingNote("That one is already sorted. Everything waiting for you is below.")
            }
        case .chat(let id):
            // The message itself is the landing: open the
            // conversation it lives in (HomeFeedView observes this)
            // and scroll to it — but only when it is actually in
            // the transcript after the pull. Otherwise say so in
            // one line instead of opening a bare conversation.
            if chatTranscript.contains(where: { $0.id == id }) {
                pendingChatMessageID = id
                pendingChatOpenID = id
            } else {
                // No message to scroll to: drop any stale id so a
                // later open does not chase it again.
                pendingChatMessageID = nil
                setRoutingNote(pulled
                    ? "That message isn't here anymore. Everything waiting for you is below."
                    : "I couldn't reach your conversation just now. Everything waiting for you is below.")
            }
        case .feedItem(let id):
            if opportunities.contains(where: { $0.id == id }) {
                highlightedOpportunityID = id
                pendingOpportunityOpenID = id
            } else {
                highlightedOpportunityID = nil
                setRoutingNote("Fresh work is waiting in your feed below.")
            }
        case .email(let id):
            await refreshHyggeEmail()
            if filedEmailSummaries.contains(where: { $0.id.lowercased() == id.uuidString.lowercased() }) {
                pendingEmailOpenID = id
            } else {
                setRoutingNote("That mail is filed under Hygge email in your profile.")
            }
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
        PushInbox.lastDeliveredTokenHex = nil
        PushInbox.pendingRoute = nil
        PushInbox.pendingForegroundDelivery = false
        notificationPrimerVisible = false
        pendingTaskOpenID = nil
        pendingOpportunityOpenID = nil
        pendingEmailOpenID = nil
        pendingNotificationsOpen = false
        pendingTaskFocusOpenID = nil
        pendingProposalOpenID = nil
        pendingEventOpenID = nil
        pendingChatOpenID = nil
        pendingChatMessageID = nil
        highlightedOpportunityID = nil
        await backend.signOut()
        isSignedIn = false
        isExistingAccount = false
        passwordFlow = nil
        magicLinkFlow = nil
        pendingChatContext = nil
        pendingOnboardingProfile = nil
        magicLinkError = nil
        wantsOnboarding = false
        // hasSignedInBefore now routes signed-out launches (this
        // one included) straight to the log in page.
        wantsSignIn = true
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

    /// Deletes the account server-side, then runs the same local wipe as
    /// sign-out. Returns false when the server request fails, leaving the
    /// app signed in so the user can retry.
    func deleteAccount() async -> Bool {
        guard await backend.deleteAccount() else { return false }
        await signOut()
        return true
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
        lastMessage = "I've found \(proposals.count) job sites that fit you — starting with the one below. Say yes and I'll handle the signup from there."
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
        if plan.rested { lastMessage = planRestMessage; return }
        if !canJoinAnotherSite { lastMessage = planSiteCapMessage; return }
        guard let index = proposals.firstIndex(where: { $0.id == proposalID }),
              let site = site(id: proposals[index].siteID),
              proposals[index].status == .proposed else { return }
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
            ? AgentTaskFactory.connectTask(profile: profile, site: site)
            : (hyggeEmailAddress.map {
                AgentTaskFactory.signupTask(profile: profile, site: site,
                                            emailChoice: .hygge, signupEmail: $0.address)
            } ?? AgentTaskFactory.signupTask(profile: profile, site: site))
        attachCredential(&task)
        attachSkill(&task)
        tasks.append(task)
        if alreadyHasAccount && credential(forDomain: site.domain) == nil && sessionProfile(forDomain: site.domain)?.hasProfile != true {
            let request = TaskHelp(kind: .credentials,
                message: "Connect your \(site.name) login so I can find work there. Add it securely below; don't send your password in chat.",
                actionLabel: "Connect account")
            tasks[tasks.count - 1].help = request
            tasks[tasks.count - 1].status = .needsHuman
            surfaceTaskHelp(taskID: task.id)
            conversationTaskID = task.id
            save()
            return
        }
        lastMessage = "Joining \(site.name) — I'll work it out on the live site and let you know if I need you."
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

    /// Only a successful secure save resumes setup. Dismissing the sheet
    /// leaves its chat request available for later.
    func finishCredentialSave(_ request: CredentialSaveRequest, saved: Bool) {
        if pendingCredentialSave?.id == request.id { pendingCredentialSave = nil }
        guard saved, let taskID = request.taskID,
              let index = tasks.firstIndex(where: { $0.id == taskID }) else { save(); return }
        attachCredential(&tasks[index])
        // The thread shows the choice, never the login itself.
        appendChat(fromAgent: false, text: "I've added my \(request.siteName) login.")
        save()
        if isPaused {
            lastMessage = "Saved for later — Hygge is paused, so joining \(request.siteName) will wait until you resume."
            return
        }
        if let request = tasks[index].help {
            _ = tasks[index].prepareReply(helpID: request.id)
        }
        Task { await approveAndRun(taskID: taskID) }
    }

    func dismissProposal(proposalID: UUID) {
        guard let index = proposals.firstIndex(where: { $0.id == proposalID }) else { return }
        proposals[index].status = .dismissed
        // The dismissed site stays in the site list, which is
        // what keeps mail from ever re-suggesting it — the mail's
        // sender (often just a forwarder) is not punished for it.
        dismissedProposalID = proposalID
        recordFeedback(FeedbackEvent(subjectType: .siteProposal,
                                     subjectId: proposalID.uuidString.lowercased(),
                                     action: .dismissed,
                                     category: nil))
        save()
    }

    func undoSiteDismissal(proposalID: UUID? = nil) {
        guard let id = proposalID ?? dismissedProposalID, let index = proposals.firstIndex(where: { $0.id == id }), proposals[index].status == .dismissed else { return }
        proposals[index].status = .proposed
        dismissedProposalID = nil
        save()
    }

    func findMoreProposals() {
        guard !isPaused else { lastMessage = "Hygge is paused — resume and I'll look for more job sites."; return }
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
                if let existing = proposals.firstIndex(where: { $0.siteID == site.id }) {
                    // A fresh server rank replaces the stored one:
                    // the server ranker is the one ordering truth.
                    if let rankScore = dto.rankScore { proposals[existing].rankScore = rankScore }
                } else {
                    proposals.append(ProposedSite(siteID: site.id, rationale: dto.rationale,
                                                   rankScore: dto.rankScore))
                }
            }
        }
        save()
    }

    func answerInformation(taskID: UUID, answers: [String: String]) {
        guard let task = tasks.first(where: { $0.id == taskID }), let help = task.help else { return }
        Task { await replyToTask(taskID: taskID, helpID: help.id, answers: answers) }
    }

    /// Surface a task's help request in the chat. A proactive call — the
    /// polls and a run reporting its outcome — only pings the user when
    /// the request is something they need or can act on; a backend break
    /// is repaired silently and the help is still there when they open
    /// the chat for the task. A user-initiated call (a tap on a feed
    /// card) always surfaces it, spending the cleared-thread
    /// suppression when one is set.
    func surfaceTaskHelp(taskID: UUID, userInitiated: Bool = false, proactive: Bool = false) {
        guard let index = tasks.firstIndex(where: { $0.id == taskID }), tasks[index].needsChatHelp else { return }
        if tasks[index].help == nil {
            let task = tasks[index]
            // A stuck step is a review, whatever the status: the user is
            // the only one who can say whether it happened on the site.
            // Keying the review off the pending effect (not the help kind)
            // is what makes the buttons render for a needsHuman task with
            // no help. The id is derived from the help's content, so the
            // 3s poll re-synthesizes the same help instead of minting a
            // fresh id — and a duplicate chat entry — on every pull.
            let reviewing = task.pendingEffectID != nil
            tasks[index].help = TaskHelp(
                id: TaskHelp.stableSynthesizedID(taskID: task.id, status: task.status.rawValue,
                                                 pendingEffectID: task.pendingEffectID,
                                                 informationRequests: task.informationRequests),
                kind: reviewing || task.status == .failed ? .recovery : task.informationRequests.isEmpty ? .verification : .information,
                message: reviewing ? "I couldn't confirm whether the last step went through. Did it happen on the site?"
                    : task.status == .failed ? "I couldn't finish this step. Let's check where it stopped before continuing."
                    : task.informationRequests.isEmpty ? "This site has a check I couldn't finish. Your progress is saved."
                    : "I need a detail to continue.",
                questions: task.informationRequests.map { .init(text: $0) },
                actionLabel: reviewing || task.status == .failed ? "Check and continue" : "Complete check")
        }
        if proactive, !userInitiated, !tasks[index].helpIsActionable { return }
        guard let help = tasks[index].help else { return }
        // A thread cleared by a reset stays cleared: the poll and
        // the pull must not regrow its decision entries. A tap on
        // the feed card is the user asking for this help in chat,
        // so it spends the suppression and the entry stays.
        if clearedHelpIDs.contains(help.id) {
            guard userInitiated else { return }
            clearedHelpIDs.remove(help.id)
            writeCache()
        }
        // Single source for the chat entry: the message the server
        // wrote for this help already counts, so never synthesize a
        // second one beside it. The server mirror carries the help's
        // own id as the message id, so match on either field — a row
        // that arrived without its helpID field still dedupes. A tap
        // still reaches this path, and it still synthesizes when no
        // server message exists.
        guard !chatTranscript.contains(where: {
            $0.helpID == help.id || $0.id == help.id
        }) else { return }
        chatTranscript.append(ChatEntry(id: help.id, fromAgent: true,
            text: help.message + (help.questions.first.map { "\n\n" + $0.text } ?? ""), taskID: taskID, helpID: help.id))
    }

    /// Answer a chat help request. Whatever the user tapped or typed
    /// is consolidated into the thread as their own message — typed
    /// answers verbatim, approvals as a fixed line, and button-only
    /// replies (retry, check-and-continue) as the button's label —
    /// so the history never reads as Hygge talking to itself.
    func replyToTask(taskID: UUID, helpID: UUID, answers: [String: String] = [:], approved: Bool = false,
                     choiceLabel: String? = nil) async {
        guard let original = tasks.first(where: { $0.id == taskID }), original.help?.id == helpID else { return }
        if original.help?.kind == .recovery,
           let remote = try? await backend.setupTasks(),
           let current = remote.first(where: { $0.id == taskID }), current.help?.id != helpID {
            if let choiceLabel { appendChat(fromAgent: false, text: choiceLabel) }
            if let index = tasks.firstIndex(where: { $0.id == taskID }) { tasks[index] = current }
            surfaceTaskHelp(taskID: taskID)
            if current.status == .succeeded {
                if current.kind == .signup { accountStates[current.siteID] = current.connectsExistingAccount ? .watching : .hasAccount }
                if current.kind == .buildProfile { accountStates[current.siteID] = .watching }
                recordTaskEvent(current)
                appendChat(fromAgent: true, text: "That step finished successfully. You're all set.")
            }
            save()
            return
        }
        guard let index = tasks.firstIndex(where: { $0.id == taskID }),
              tasks[index].prepareReply(helpID: helpID, answers: answers, approved: approved) else { return }
        if !answers.isEmpty {
            appendChat(fromAgent: false, text: answers.keys.sorted().compactMap { answers[$0] }.joined(separator: "\n"))
        } else if approved {
            appendChat(fromAgent: false, text: "Approve and continue.")
        } else if let choiceLabel {
            appendChat(fromAgent: false, text: choiceLabel)
        }
        await approveAndRun(taskID: taskID)
    }

    /// Review the outcome of a step whose browser session is gone: the
    /// user says whether it happened on the site, and that review clears
    /// the stuck step. The task comes back still waiting, with a new help
    /// request — the next tap ("Check and continue") resumes it.
    func reviewTask(taskID: UUID, helpID: UUID, effectID: String, confirmed: Bool) async {
        guard let index = tasks.firstIndex(where: { $0.id == taskID }),
              tasks[index].help?.id == helpID,
              let backendID = tasks[index].backendTaskID else { return }
        appendChat(fromAgent: false, text: confirmed ? "It worked." : "It didn't work.")
        do {
            _ = try await backend.reconcileTask(id: backendID, effectID: effectID,
                                                status: confirmed ? "confirmed" : "not_applied")
        } catch {
            appendChat(fromAgent: true, text: "I couldn't save that. Please try again.")
            return
        }
        if let remote = try? await backend.setupTasks(),
           let current = remote.first(where: { $0.id == taskID }),
           let currentIndex = tasks.firstIndex(where: { $0.id == taskID }) {
            tasks[currentIndex] = current
        }
        surfaceTaskHelp(taskID: taskID)
        save()
    }

    func declineTaskHelp(taskID: UUID, helpID: UUID, choiceLabel: String? = nil) async {
        guard let index = tasks.firstIndex(where: { $0.id == taskID }), tasks[index].help?.id == helpID else { return }
        if let id = tasks[index].backendTaskID {
            do { try await backend.rejectTask(id: id, helpID: helpID) }
            catch { appendChat(fromAgent: true, text: "I couldn't save that choice. Please try again."); return }
        }
        guard let current = tasks.firstIndex(where: { $0.id == taskID }),
              tasks[current].stopHelp(helpID: helpID) else { return }
        // Recorded only once the stop really saved, so the thread
        // never shows the user stopping something that still runs.
        if let choiceLabel { appendChat(fromAgent: false, text: choiceLabel) }
        appendChat(fromAgent: true, text: "Okay — I won't continue that step.")
        save()
    }

    @ObservationIgnored private var browserResumeIDs: Set<UUID> = []
    @ObservationIgnored private var browserSessions: [String: LiveBrowserSession] = [:]
    /// Last warm signal sent, so the foreground loop and the poll loops
    /// in several views don't each fire one: at most one keepalive a
    /// minute across all of them.
    @ObservationIgnored private var lastKeepaliveAt: Date?

    /// The workspace stays warm while the app is open: the foreground
    /// loop beats every minute, and the task poll calls this too.
    /// Best-effort and idempotent; a missed beat costs nothing because
    /// the next call rebinds a dead container instead of failing.
    func sendKeepaliveIfDue() async {
        if let last = lastKeepaliveAt, Date().timeIntervalSince(last) < 50 { return }
        lastKeepaliveAt = Date()
        await backend.keepWorkspaceWarm()
    }
    func browserSession(_ id: String) -> LiveBrowserSession {
        if let session = browserSessions[id], session.accountToken == backend.apiToken { return session }
        let session = LiveBrowserSession(id: id, backend: backend)
        browserSessions[id] = session
        return session
    }
    /// Read running session IDs without overwriting a locally owned task request.
    func observeBrowserTasks() async {
        while !Task.isCancelled {
            await sendKeepaliveIfDue()
            let token = backend.apiToken
            if let remote = try? await backend.setupTasks(), token == backend.apiToken {
                for task in remote {
                    guard let index = tasks.firstIndex(where: { $0.id == task.id }) else { continue }
                    if runningTaskIDs.contains(task.id) {
                        tasks[index].browserSessionID = task.browserSessionID
                        tasks[index].backendTaskID = task.backendTaskID
                    } else { tasks[index] = task }
                }
                for task in chatHelpTasks { surfaceTaskHelp(taskID: task.id, proactive: true) }
            }
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
        }
    }
    func browserDidResume(_ taskID: UUID) {
        if runningTaskIDs.contains(taskID) { browserResumeIDs.insert(taskID) }
        if let index = tasks.firstIndex(where: { $0.id == taskID }) {
            tasks[index].status = .running
            tasks[index].help = nil
            tasks[index].pendingReply = nil
        }
        conversationTaskID = taskID
        appendChat(fromAgent: false, text: "Done — over to you.")
        appendChat(fromAgent: true, text: "Thanks — I’ll check your changes and carry on.")
    }

    var chatHelpTasks: [AgentTask] { tasks.filter { $0.needsChatHelp } }

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
    /// Returns false when the save could not be confirmed.
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
            lastMessage = "We couldn’t confirm that your login was saved. Enter your password again to retry."
            save()
            return false
        }
    }

    /// Deletes one saved login. The site's trusted sign-in is separate
    /// and stays (forget it on its own if you want both gone).
    @discardableResult
    func deleteCredential(id: UUID) async -> Bool {
        guard let ref = credentialRefs.first(where: { $0.id == id }) else { return true }
        guard await backend.deleteCredential(id: ref.id) else {
            lastMessage = "We couldn’t confirm removal of your saved login. Please try again."
            return false
        }
        credentialRefs.removeAll { $0.id == ref.id }
        lastMessage = sessionProfile(forDomain: ref.domain)?.hasProfile == true
            ? "Saved login removed. The remembered sign-in for \(ref.domain) remains."
            : "Saved login for \(ref.domain) removed."
        save()
        return true
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
        guard !refreshingEmail else { return }
        refreshingEmail = true
        defer { refreshingEmail = false }
        if let address = try? await backend.hyggeEmailAddress() { hyggeEmailAddress = address }
        do {
            let inbox = try await backend.filedEmailInbox()
            filedEmailSummaries = inbox.messages
            ignoredSenderDomains = inbox.ignoredDomains
            emailNextCursor = inbox.nextCursor
            emailHasLoaded = true
            emailRefreshError = nil
        } catch {
            emailRefreshError = "Couldn’t refresh email. Previously loaded summaries are still here."
        }
    }

    func loadOlderEmail() async {
        guard let cursor = emailNextCursor, !loadingOlderEmail, !refreshingEmail else { return }
        loadingOlderEmail = true
        defer { loadingOlderEmail = false }
        do {
            let page = try await backend.filedEmailInbox(cursor: cursor)
            guard emailNextCursor == cursor else { return }
            let known = Set(filedEmailSummaries.map(\.id))
            filedEmailSummaries += page.messages.filter { !known.contains($0.id) }
            emailNextCursor = page.nextCursor
            emailRefreshError = nil
        } catch { emailRefreshError = "Couldn’t load older mail. Please try again." }
    }

    func originalEmail(id: String) async throws -> OriginalEmail? { try await backend.originalEmail(id: id) }
    func refreshOwnEmailAddresses() async throws { ownEmailAddresses = try await backend.ownEmailAddresses() }
    func addOwnEmailAddress(_ address: String) async throws -> OwnEmailAddress {
        let result = try await backend.addOwnEmailAddress(address)
        ownEmailAddresses.removeAll { $0.address == result.address }
        ownEmailAddresses.append(result)
        return result
    }
    func removeOwnEmailAddress(_ address: String) async -> Bool {
        guard await backend.removeOwnEmailAddress(address) else { return false }
        ownEmailAddresses.removeAll { $0.address == address }
        return true
    }
    func markEmailAsMe(id: String, marked: Bool) async throws -> OwnEmailAddress? {
        let response = try await backend.markEmailAsMe(id: id, marked: marked)
        if let index = filedEmailSummaries.firstIndex(where: { $0.id == id }) { filedEmailSummaries[index].markedAsMe = response.marked }
        if let address = response.ownerAddress {
            ownEmailAddresses.removeAll { $0.address == address.address }
            ownEmailAddresses.append(address)
        }
        return response.ownerAddress
    }

    /// The one sender call the user can make: ignore this sender
    /// (silent filing, no evaluation) — or undo that. Remembered
    /// where the mail arrives.
    @discardableResult
    func decideEmailSender(domain: String, choice: String) async -> Bool {
        guard await backend.decideEmailSender(domain: domain, choice: choice) else { return false }
        ignoredSenderDomains = choice == "ignore"
            ? Array(Set(ignoredSenderDomains + [domain])).sorted()
            : ignoredSenderDomains.filter { $0 != domain }
        filedEmailSummaries = filedEmailSummaries.map { mail in
            guard mail.senderDomain == domain else { return mail }
            var copy = mail
            copy.decision = choice == "ignore" ? "ignore" : "work"
            return copy
        }
        return true
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

    /// Plus custom email name: choose or change it. The digits
    /// address keeps working either way.
    func setCustomEmailName(_ name: String) async -> BackendClient.EmailAliasOutcome {
        let outcome = await backend.setEmailAlias(name)
        if case .set = outcome { await refreshHyggeEmail() }
        return outcome
    }

    /// Own-email path: the user confirms their own email for a site
    /// and a suggested site password. The password goes once to the
    /// safe store via the normal save-login path — nowhere else.
    func saveOwnEmailLogin(domain: String, email: String, secret: String) async -> Bool {
        await addCredential(domain: domain, username: HyggeAuth.normalizeEmail(email), secret: secret)
    }

    /// Forgets one trusted sign-in. The saved login is kept, so the
    /// next visit simply signs in with it again.
    @discardableResult
    func deleteSessionProfile(domain: String) async -> Bool {
        guard await backend.deleteSessionProfile(domain: domain) else {
            lastMessage = "We couldn’t confirm removal of the remembered sign-in. Please try again."
            return false
        }
        sessionProfileRefs.removeAll { $0.domain == domain }
        lastMessage = credential(forDomain: domain) != nil
            ? "Remembered sign-in for \(domain) forgotten. Your saved login remains."
            : "Remembered sign-in for \(domain) forgotten."
        save()
        return true
    }

    // MARK: - Opportunities & applications

    func setStatus(_ status: OpportunityStatus, for opportunityID: UUID) {
        guard let index = opportunities.firstIndex(where: { $0.id == opportunityID }) else { return }
        opportunities[index].status = status
        save()
    }

    func draftApplication(for opportunity: Opportunity) {
        if plan.rested { lastMessage = planRestMessage; return }
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
        // New searches rest at the free limit; work already under
        // way (other kinds) is untouched.
        if kind == .discover, plan.rested { lastMessage = planRestMessage; return }
        var task = AgentTaskFactory.customTask(site: site, goal: goal, kind: kind)
        attachCredential(&task)
        attachSkill(&task)
        tasks.append(task)
        lastMessage = "Task drafted for \(site.name). The agent will explore it live from your goal; any memory hints are advisory."
        save()
    }

    func draftSignup(site: TargetSite) {
        if plan.rested { lastMessage = planRestMessage; return }
        if !canJoinAnotherSite { lastMessage = planSiteCapMessage; return }
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

    private func recordTaskEvent(_ task: AgentTask) {
        if task.isSiteSetup && activityEvents.contains(where: { $0.id == task.id }) { return }
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
            recordEvent(ActivityEvent(id: task.id, kind: .joinedSite, sentence: task.connectsExistingAccount ? "Connected your \(site) account." : "Set you up on \(site).", siteID: task.siteID))
            recordFeedbackOnce(FeedbackEvent(subjectType: .signup, subjectId: task.siteID,
                                             action: .signupApproved,
                                             category: self.site(id: task.siteID)?.category))
        case .buildProfile:
            recordEvent(ActivityEvent(id: task.id, kind: .profileLive, sentence: "Your \(site) profile is live.", siteID: task.siteID))
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
        guard let index = tasks.firstIndex(where: { $0.id == taskID }), !runningTaskIDs.contains(taskID) else { return nil }
        let runAccountToken = backend.apiToken
        runningTaskIDs.insert(taskID)
        defer { runningTaskIDs.remove(taskID) }
        noteRunStarted()
        defer { noteRunFinished() }
        var finalStatus: AgentTaskStatus?
        do {
            var task = tasks[index]
            if let reply = task.pendingReply {
                // Legacy cached tasks have no stable backend ID yet. Carry their
                // answers into the first durable task without another approval.
                if task.backendTaskID == nil {
                    for (question, answer) in reply.answers {
                        let key = question.lowercased().contains("phone") ? "phone"
                            : question.lowercased().contains("date of birth") ? "dateOfBirth" : "answer:" + question
                        task.draftedPayload[key] = answer
                    }
                }
                task.status = .approved
            } else if task.status == .needsHuman || task.status == .failed {
                surfaceTaskHelp(taskID: taskID)
                conversationTaskID = taskID
                save()
                return task.status
            } else {
                try task.approve()
            }
            tasks[index].status = .running
            save()

            if task.kind == .bookCalendar {
                task = try localRunner.run(task, repository: &siteMemory)
                if await CalendarService.book(payload: task.draftedPayload) {
                    task.log.append("Added to your calendar.")
                } else {
                    task.status = .needsHuman
                    task.help = TaskHelp(kind: .verification,
                        message: "I couldn't add this to your calendar. Check that calendar access is enabled, then I'll try again.",
                        actionLabel: "Try calendar again")
                    task.log.append("Calendar permission not granted. Enable it for Hygge, then approve again.")
                }
            } else if let result = try? await backend.runTask(task: task) {
                task.backendTaskID = result.id
                task.help = result.help
                task.pendingReply = nil
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
                task.help = nil
                task.pendingReply = nil
                task.log.append("The connection was interrupted. Checking the existing task will recover its latest status.")
            } else {
                task.log.append("Working offline for this one — I could not reach the live helper.")
                task = try localRunner.run(task, repository: &siteMemory)
            }

            guard backend.apiToken == runAccountToken,
                  tasks.contains(where: { $0.id == taskID }) else { return nil }
            if browserResumeIDs.remove(taskID) != nil,
               let remote = try? await backend.setupTasks(), let current = remote.first(where: { $0.id == taskID }), backend.apiToken == runAccountToken {
                task = current
            }
            if task.status == .succeeded {
                task.help = nil
                task.pendingReply = nil
                if task.kind == .signup { accountStates[task.siteID] = task.connectsExistingAccount ? .watching : .hasAccount }
                if task.kind == .buildProfile { accountStates[task.siteID] = .watching }
                recordTaskEvent(task)
            }
            if task.kind == .apply, task.status == .succeeded, let oppID = task.opportunityID {
                if let appIndex = applications.firstIndex(where: { $0.opportunityID == oppID }) {
                    applications[appIndex].stage = .submitted
                }
                setStatus(.applied, for: oppID)
            }
            guard let current = tasks.firstIndex(where: { $0.id == taskID }) else { return nil }
            tasks[current] = task
            surfaceTaskHelp(taskID: taskID, proactive: true)
            finalStatus = task.status
            if task.status == .needsHuman, task.kind == .signup {
                accountStates[task.siteID] = .needsVerification
            }
            if task.needsChatHelp {
                // A backend break is repaired silently; only a help request
                // the user can act on gets announced here.
                if task.helpIsActionable { lastMessage = "\(siteName(id: task.siteID)) needs your help in chat." }
            } else if task.status == .succeeded {
                lastMessage = "Finished: \(task.title)"
            } else {
                lastMessage = "Working on \(siteName(id: task.siteID))…"
            }
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
                let why = status == .needsHuman ? "it needs your help" : "it didn't go through"
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
        archivedFeedIDs = []
        discussedTaskIDs = []
        profile = EarningsProfile()
        profilePhotoData = nil
        profilePhotoNeedsUpload = false
        profilePhotoIsLegacy = false
        profilePhotoSyncError = nil
        profilePhotoRevision += 1
        profilePhotoAccountEpoch += 1
        photoSyncTask?.cancel()
        photoSyncTask = nil
        isSyncingProfilePhoto = false
        pendingProfileEdit = false
        profileEditRevision += 1
        hyggeEmailAddress = nil
        filedEmailSummaries = []
        ownEmailAddresses = []
        emailNextCursor = nil
        emailHasLoaded = false
        emailRefreshError = nil
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
        pendingConversationMessageID = nil
        pendingConversationGeneration = nil
        conversationNeedsReconciliation = false
        clearedHelpIDs = []
        lastConversationGeneration = nil
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

    /// The server's conversation generation changed since the last
    /// refresh: the thread was cleared (reset), so the decision
    /// messages cleared with it stay cleared instead of being
    /// re-synthesized by the next poll. Record the helps
    /// outstanding right now — a help whose situation later
    /// changes mints a fresh id and synthesizes again, as it
    /// should. The first generation seen only establishes the
    /// baseline; a reset is a change from a known generation.
    /// Call before the pull that follows the state fetch, so the
    /// pull's synthesis already respects the suppression.
    func noteConversationGeneration(_ generation: String) {
        let changed = lastConversationGeneration != generation
        if let last = lastConversationGeneration, last != generation {
            for task in chatHelpTasks {
                if let help = task.help { clearedHelpIDs.insert(help.id) }
                else {
                    clearedHelpIDs.insert(TaskHelp.stableSynthesizedID(taskID: task.id, status: task.status.rawValue,
                        pendingEffectID: task.pendingEffectID, informationRequests: task.informationRequests))
                }
            }
        }
        lastConversationGeneration = generation
        if changed { writeCache() }
    }

    func saveConversationOutbox(messageID: UUID?, generation: String? = nil) {
        pendingConversationMessageID = messageID
        pendingConversationGeneration = generation
        writeCache()
    }

    /// Fence full-cache imports until the agent's canonical mutations have been pulled.
    func beginConversationRequest() async {
        let pendingPush = pushTask
        pushTask?.cancel()
        await pendingPush?.value
        if !conversationNeedsReconciliation { await pushStateNow() }
        pushTask?.cancel()
        conversationNeedsReconciliation = true
        writeCache()
    }

    func appendConversationMessage(fromAgent: Bool, text: String, context: ChatContextRef? = nil, id: UUID = UUID()) {
        guard !chatTranscript.contains(where: { $0.id == id }) else { return }
        chatTranscript.append(ChatEntry(id: id, fromAgent: fromAgent, text: text, context: context))
        writeCache()
    }

    func appendChat(fromAgent: Bool, text: String, context: ChatContextRef? = nil, id: UUID = UUID()) {
        guard !chatTranscript.contains(where: { $0.id == id }) else { return }
        chatTranscript.append(ChatEntry(id: id, fromAgent: fromAgent, text: text, context: context))
        save()
    }

    /// Transcript as the model sees it: a message sent about a
    /// card carries a plain "[about: …]" tag so "this" resolves
    /// without polluting what the user reads in the thread.
    func chatTranscriptLines() -> [BackendClient.TranscriptLine] {
        chatTranscript.map { entry in
            var text = entry.text
            if let context = entry.context {
                text += " [about: \(context.title)"
                if !context.subtitle.isEmpty { text += " — \(context.subtitle)" }
                text += "]"
            }
            return BackendClient.TranscriptLine(fromAgent: entry.fromAgent, text: text)
        }
    }

    var journalEntries: [JournalEntry] { JournalBuilder.entries(from: activityEvents) }

    func recordEvent(_ event: ActivityEvent) {
        activityEvents.append(event)
        save()
    }

    /// Urgent decisions only. Optional site suggestions never inflate this.
    var needsYouCount: Int {
        tasks.filter { $0.status == .awaitingApproval || $0.needsChatHelp }.count
    }

    /// What the flame badge may promise: only what tapping him
    /// (opening the chat) can actually resolve — help waiting in
    /// the thread, plus agent messages not yet read there. Feed
    /// decisions and drafts live in the feed the user is already
    /// looking at; counting them here strands the badge forever.
    var chatBadgeCount: Int {
        let waitingHelp = tasks.filter { $0.needsChatHelp }.count
        let unread = chatTranscript.filter {
            $0.fromAgent && $0.taskID == nil && $0.createdAt > chatLastReadAt
        }.count
        return waitingHelp + unread
    }

    func markChatRead() {
        if let latest = chatTranscript.map(\.createdAt).max(), latest > chatLastReadAt {
            chatLastReadAt = latest
        }
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

    @discardableResult
    func proposeBelief(sentence: String, source: Belief.Source, confidence: Double) -> Bool {
        let added = beliefs.propose(sentence: sentence, source: source, confidence: confidence)
        if added { save() }
        return added
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
        case .scanSite(let siteID):
            return scanSiteFromChat(siteID: siteID)
        case .joinSite(let siteID):
            guard let site = site(id: siteID) else { return "I don't have that site yet — tell me its address, like “add pawshake.com”." }
            return joinSiteFromChat(site)
        case .addSite(let domain):
            return addSiteFromChat(domain: domain)
        case .checkEmail:
            return await checkEmailFromChat()
        case .readMail(let mailID, let act):
            guard hyggeEmailAddress != nil else { return await checkEmailFromChat() }
            guard let mailID else { return inboxReadOut() }
            guard let mail = filedEmailSummaries.first(where: { $0.id.lowercased() == mailID.lowercased() }) else {
                return "That email is no longer in your inbox, so I left that request undone."
            }
            return actOnResolvedMail(EmailReferenceResolver.Resolution(mail: mail, wantsAction: act),
                                     askText: act ? "handle this email" : "")
        }
    }

    /// Chat "scan <site>": start a real read-only search now, or say
    /// plainly why not. The reply is written after the search task
    /// exists, so it can never promise work that was not started.
    private func scanSiteFromChat(siteID: String) -> String {
        guard let site = site(id: siteID) else {
            return "I don't have that site yet — tell me “add <site address>” and I'll set it up first."
        }
        if isPaused {
            return "I'm paused right now, so I can't look yet. Say “resume”, then ask me again and I'll check \(site.name) straight away."
        }
        if plan.rested { return planRestMessage }
        if tasks.contains(where: { $0.siteID == siteID && $0.kind == .discover && ($0.status == .running || $0.status == .approved) }) {
            return "I'm already looking on \(site.name) — anything that fits will land on your Home screen."
        }
        let state = accountStates[siteID] ?? .unknown
        if state == .joining || state == .needsVerification {
            return "I'm still setting up \(site.name). Once that's finished I can look for work there."
        }
        guard state.isWatching || state == .hasAccount else {
            return "You're not set up on \(site.name) yet, so there's nothing to search. Say “add \(site.domain)” and I'll join it first."
        }
        var task = AgentTaskFactory.discoverTask(profile: profile, site: site)
        attachCredential(&task)
        attachSkill(&task)
        tasks.append(task)
        save()
        let taskID = task.id
        Task { await approveAndRun(taskID: taskID) }
        return "Looking on \(site.name) now. Anything that fits will appear on your Home screen, and the check will be in your journal."
    }

    /// Chat "add <known site>" / "re-add <site>": restore the site's
    /// suggestion if it was dismissed or stopped, then start joining.
    /// The user's sentence is the consent for this one site.
    private func joinSiteFromChat(_ site: TargetSite) -> String {
        if plan.rested { return planRestMessage }
        if !canJoinAnotherSite { return planSiteCapMessage }
        let state = accountStates[site.id] ?? .unknown
        if state.isWatching || state == .hasAccount {
            return "You're already set up on \(site.name) — I'm watching it for work."
        }
        if state == .joining || state == .needsVerification {
            return "\(site.name) is already being set up. I'll let you know if I need you."
        }
        if proposals.contains(where: { $0.siteID == site.id && ($0.status == .approvedSignup || $0.status == .approvedHasAccount) }),
           tasks.contains(where: { $0.siteID == site.id && $0.kind == .signup && ($0.status == .running || $0.status == .approved || $0.status == .needsHuman) }) {
            return "\(site.name) is already being set up. I'll let you know if I need you."
        }
        let proposalID: UUID
        if let index = proposals.firstIndex(where: { $0.siteID == site.id }) {
            let existing = proposals[index]
            if existing.status == .dismissed { undoSiteDismissal(proposalID: existing.id) }
            else if existing.status == .approvedSignup || existing.status == .approvedHasAccount {
                // An earlier join attempt ended without an account; the
                // fresh ask reopens the suggestion so joining can restart.
                proposals[index].status = .proposed
            }
            proposalID = existing.id
        } else {
            let details = ConsentCatalog.details(for: site)
            let proposal = ProposedSite(siteID: site.id, rationale: "You asked me to add this job site.",
                                        payPattern: details.pay, dataShared: details.data, verification: details.verification)
            proposals.append(proposal)
            proposalID = proposal.id
        }
        // A stopped/disconnected site blocks suggestions; the user's own
        // ask is what unblocks it, and joining re-decides the state.
        if state.blocksSuggestions || accountStates[site.id] == nil {
            accountStates[site.id] = .proposed
        }
        save()
        let hasAccount = credential(forDomain: site.domain) != nil
            || sessionProfile(forDomain: site.domain)?.hasProfile == true
        approveProposal(proposalID: proposalID, alreadyHasAccount: hasAccount)
        if let task = tasks.last(where: { $0.siteID == site.id && $0.kind == .signup }),
           task.status == .needsHuman, task.help?.kind == .credentials {
            return "One thing first: connect your \(site.name) login in the card above, and I'll carry on from there."
        }
        if isPaused {
            return "Saved for later — I'm paused, so joining \(site.name) will wait until you resume."
        }
        return "Joining \(site.name) now. I'll work it out on the live site and let you know if I need you."
    }

    /// Chat "add <address>": a known address joins that site; a new
    /// address is added to the site list first, then joined.
    private func addSiteFromChat(domain: String) -> String {
        if let existing = sites.first(where: { $0.domain == domain || $0.id == domain }) {
            return joinSiteFromChat(existing)
        }
        let label = domain.split(separator: ".").first.map(String.init) ?? domain
        let name = label.prefix(1).uppercased() + label.dropFirst()
        addSite(name: name, urlOrDomain: domain, category: profile.interests.first ?? .localGig)
        guard let site = sites.first(where: { $0.domain == domain }) else {
            return lastMessage ?? "That doesn't look like a site address I can use."
        }
        return joinSiteFromChat(site)
    }

    /// Chat "check your email": read the inbox back — newest few,
    /// in the mail's own (already redacted) words.
    private func checkEmailFromChat() async -> String {
        await refreshHyggeEmail()
        guard hyggeEmailAddress != nil else {
            return "Your Hygge email isn't set up yet. You'll find it in your profile, under Hygge email."
        }
        return inboxReadOut()
    }

    private func inboxReadOut() -> String {
        guard !filedEmailSummaries.isEmpty else {
            return "Nothing has arrived in your Hygge inbox yet."
        }
        let lines = filedEmailSummaries.prefix(3).map { mail in
            "• “\(mail.subject.isEmpty ? "Mail from \(mail.senderDomain)" : mail.subject)” from \(mail.senderDomain) — \(truncatedForChat(mail.summary, limit: 160))"
        }
        var reply = "Here's what's in your inbox:\n" + lines.joined(separator: "\n")
        if filedEmailSummaries.count > 3 {
            reply += "\n…\(filedEmailSummaries.count) filed in all. The full list is under Hygge email in your profile."
        }
        return reply
    }

    private func truncatedForChat(_ text: String, limit: Int) -> String {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard clean.count > limit else { return clean }
        let cut = clean.prefix(limit)
        let boundary = cut.lastIndex(of: " ")
        return "\(boundary.map { cut[..<$0] } ?? Substring(cut))…"
    }

    // MARK: - Model-led intent, app-validated

    enum ModelIntentOutcome {
        case handled(String)
        case needsConfirmation(ChatActionBatch.Progress)
        case unhandled
    }

    private func chatIntentContext() -> BackendClient.ChatIntentContext {
        // The latest message's card, when it has one: "this" in
        // the message means exactly this object.
        let focus = chatTranscript.last(where: { !$0.fromAgent })?.context.map { context in
            BackendClient.ChatIntentContext.FocusLine(
                kind: context.kind, id: context.id, title: context.title,
                subtitle: context.subtitle, siteId: context.siteID)
        }
        return BackendClient.ChatIntentContext(
            sites: sites.map { site in
                .init(id: site.id, name: site.name, domain: site.domain,
                      state: (accountStates[site.id] ?? .unknown).label)
            },
            inbox: filedEmailSummaries.prefix(8).map { mail in
                .init(id: mail.id, senderDomain: mail.senderDomain, subject: mail.subject,
                      summary: truncatedForChat(mail.summary, limit: 240),
                      highlights: mail.highlights ?? [])
            },
            paused: isPaused,
            focus: focus)
    }

    /// Ask the model what this message wants done, then run only
    /// what validates against real state. Understanding is the
    /// model's; permission is the app's: invented sites or mail
    /// never execute, and consequential kinds still wait for the
    /// confirmation card. Any doubt falls through to the
    /// deterministic paths and then to plain conversation.
    func modelIntent(for text: String) async -> ModelIntentOutcome {
        let recent = chatTranscript.dropLast().suffix(6).map(\.text)
        if EmailReferenceResolver.mightConcernEmail(text: text, recentTranscript: recent,
                                                    inbox: filedEmailSummaries) {
            await refreshHyggeEmail()
        }
        let transcript = chatTranscriptLines()
        guard let dtos = try? await backend.chatIntentActions(transcript: transcript, profile: profile,
                                                             context: chatIntentContext()),
              !dtos.isEmpty else {
            return .unhandled
        }
        return await continueChatBatch(dtos.map(chatBatchItem))
    }

    func continueChatBatch(_ items: [ChatBatchItem]) async -> ModelIntentOutcome {
        let progress = await ChatActionBatch.run(items) { await self.performChatAction($0) }
        if progress.confirmation != nil { return .needsConfirmation(progress) }
        return .handled(progress.replies.joined(separator: " "))
    }

    private func chatBatchItem(_ dto: BackendClient.ChatIntentActionDTO) -> ChatBatchItem {
        switch dto.kind {
        case "scan", "join", "stop":
            guard let id = dto.siteId, site(id: id) != nil else {
                return .unavailable("I couldn't find the site for that \(dto.kind) request, so I left it undone.")
            }
            if dto.kind == "scan" { return .action(.scanSite(siteID: id)) }
            if dto.kind == "join" { return .action(.joinSite(siteID: id)) }
            return .action(.stopSite(siteID: id))
        case "add":
            guard let domain = dto.domain,
                  TargetSite.userAdded(name: "", urlOrDomain: domain, category: .localGig) != nil else {
                return .unavailable("I couldn't use that site address, so I haven't added it.")
            }
            return .action(.addSite(domain: domain))
        case "floor":
            guard let amount = dto.amount, amount > 0, amount < 1000 else {
                return .unavailable("I couldn't use that rate, so your lowest rate hasn't changed.")
            }
            return .action(.changeFloor(amount))
        case "approve": return .action(.approveFirst)
        case "book": return .action(.bookFirst)
        case "pause": return .action(.pause)
        case "resume": return .action(.resume)
        case "explainDropped": return .action(.explainDropped)
        case "email": return .action(.readMail(mailID: dto.mailId, act: dto.act == true))
        default: return .unavailable("I couldn't carry out one of those requests, so I left it undone.")
        }
    }

    /// A message that might be about mail ("so check it", "what did
    /// the ApartmentIQ one say?", "do something about it") is
    /// resolved against the actual inbox and the recent thread, and
    /// answered from the mail itself — the user is never bounced to
    /// reciting an exact phrase. Returns nil when mail plainly
    /// isn't meant, leaving the normal conversation to flow.
    func handleEmailAsk(text: String) async -> String? {
        let recent = chatTranscript.dropLast().suffix(6).map(\.text)
        guard EmailReferenceResolver.mightConcernEmail(text: text, recentTranscript: recent,
                                                       inbox: filedEmailSummaries) else { return nil }
        await refreshHyggeEmail()
        guard hyggeEmailAddress != nil else {
            return "Your Hygge email isn't set up yet. You'll find it in your profile, under Hygge email."
        }
        if let resolution = EmailReferenceResolver.resolve(text: text, recentTranscript: recent,
                                                           inbox: filedEmailSummaries) {
            return actOnResolvedMail(resolution, askText: text)
        }
        let lower = text.lowercased()
        if lower.contains("email") || lower.contains("inbox") || lower.contains(" mail") {
            return inboxReadOut()
        }
        return nil
    }

    /// Read one resolved mail back in its own words, then — when the
    /// user asked for action — take exactly one, chosen by evidence
    /// and named in the reply: look on the site it belongs to, join
    /// a known site, or add the site a jobs mail links to.
    private func actOnResolvedMail(_ resolution: EmailReferenceResolver.Resolution, askText: String) -> String {
        let mail = resolution.mail
        var reply = "“\(mail.subject.isEmpty ? "Mail from \(mail.senderDomain)" : mail.subject)” from \(mail.senderDomain)."
        let summary = mail.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        if !summary.isEmpty { reply += " \(truncatedForChat(summary, limit: 300))" }
        if let labels = mail.highlights, !labels.isEmpty {
            reply += " \(labels.joined(separator: ". "))."
        }
        guard resolution.wantsAction else { return reply }

        if let site = siteMatchingMail(mail) {
            let state = accountStates[site.id] ?? .unknown
            reply += " " + (state.isWatching || state == .hasAccount
                ? scanSiteFromChat(siteID: site.id)
                : joinSiteFromChat(site))
            return reply
        }
        let mentionsWork = (mail.highlights ?? []).contains { $0.localizedCaseInsensitiveContains("new work") }
        if mentionsWork, let host = EmailReferenceResolver.linkHosts(in: mail).first {
            // Adding a brand-new job site is a bigger step than reading
            // or looking: a bare "check it" reads the mail and
            // offers; "do something about it" goes ahead.
            let lower = askText.lowercased()
            let strongAsk = ["do ", "something", "handle", "sort", "go ahead", "add", "start", "watch", "follow up"]
                .contains(where: { lower.contains($0) })
            if strongAsk {
                reply += " " + addSiteFromChat(domain: host)
            } else {
                reply += " I'm not watching \(host) yet — say the word and I'll add it and start looking there."
            }
            return reply
        }
        if mail.decision == "pending" {
            reply += " This sender is new to me, so I've put it on your Home screen for your call before I act on their mail."
            return reply
        }
        reply += " Nothing else in it needs action from me — it's filed."
        return reply
    }

    private func siteMatchingMail(_ mail: FiledEmailSummary) -> TargetSite? {
        if let siteID = mail.siteID, let site = site(id: siteID) { return site }
        let hosts = [mail.senderDomain.lowercased()] + EmailReferenceResolver.linkHosts(in: mail)
        return sites.first { site in
            hosts.contains { host in host == site.domain || host.hasSuffix("." + site.domain) }
        }
    }

    /// Full reconciliation: credential, proposals, site memory, pending
    /// drafts, and future suggestions all end with the disconnect.
    @discardableResult
    func disconnect(siteID: String) async -> Bool {
        guard let site = site(id: siteID) else { return false }
        if let credential = credential(forDomain: site.domain) {
            guard await deleteCredential(id: credential.id) else { return false }
        }
        // Keep confirmed partial cleanup, but do not claim disconnection
        // until the remembered sign-in has also been removed.
        guard await deleteSessionProfile(domain: site.domain) else {
            lastMessage = "We couldn’t finish disconnecting \(site.name). Some saved access may already be removed. Please try again."
            return false
        }
        proposals.removeAll { $0.siteID == siteID }
        siteMemory.memories.removeAll { $0.domain == site.domain }
        for index in tasks.indices where tasks[index].siteID == siteID
            && (tasks[index].status == .awaitingApproval || tasks[index].status == .draft || tasks[index].status == .needsHuman) {
            try? tasks[index].reject()
        }
        accountStates[siteID] = .disconnected
        lastMessage = "Disconnected \(site.name). Saved login deleted, drafts cleared, and I won't suggest it again."
        save()
        return true
    }

    /// Plain-language context the conversation model may use (never secrets).
    var conversationContextSummary: String {
        let journal = journalEntries.prefix(5).map(\.sentence).joined(separator: " ")
        var summary = "Needs-you cards waiting: \(needsYouCount). Paused: \(isPaused). Approved sites: \(accountStates.filter { $0.value == .hasAccount || $0.value.isWatching }.keys.joined(separator: ", ")). Recent journal: \(journal)"
        if !filedEmailSummaries.isEmpty {
            let mail = filedEmailSummaries.prefix(3).map {
                "from \($0.senderDomain) “\($0.subject)” — \(truncatedForChat($0.summary, limit: 160))"
            }.joined(separator: "; ")
            summary += " Filed mail (newest first): \(mail)"
        }
        return summary
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
                     chatTranscript: chatTranscript.filter { $0.id != pendingConversationMessageID }, activityEvents: activityEvents,
                     beliefs: beliefs, searchEvidence: searchEvidence,
                     feedbackEvents: feedbackEvents)
    }

    /// Launch entry point: migrate once if needed, otherwise pull.
    /// Any failure leaves the cache exactly as it was.
    func syncOnLaunch(finishingSignIn: Bool = false) async {
        guard (!isCompletingSignIn || finishingSignIn), !isSyncing else { return }
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

    /// Pull-to-refresh on Home: the same pull foregrounding performs
    /// (plus the inbox, whose decisions appear as feed cards). Before
    /// the first successful sync this runs the launch path instead,
    /// so a pull can also complete the one-time migration. If a pull
    /// is already in flight, wait for it rather than dismissing the
    /// refresh instantly or starting a second one.
    func refreshFeed() async {
        guard !isCompletingSignIn else { return }
        if isBackendFirst {
            var waits = 0
            while isSyncing, waits < 100 {
                guard !Task.isCancelled else { return }
                try? await Task.sleep(for: .milliseconds(100))
                waits += 1
            }
            await pullFromServer()
        } else {
            await syncOnLaunch()
        }
        await refreshHyggeEmail()
    }

    /// Foreground/launch pull: reconcile durable tasks and chat requests;
    /// calls currently in flight on this device keep their local ownership.
    @discardableResult
    func pullFromServer(reconcilingConversation: Bool = false) async -> Bool {
        guard isBackendFirst, !isSyncing else { return false }
        // Opening the app starts the workspace; the foreground loop
        // keeps it warm afterwards. Fire-and-forget so a cold start
        // never slows the pull itself.
        Task { await sendKeepaliveIfDue() }
        isSyncing = true
        defer { isSyncing = false }
        if pendingProfileEdit && !conversationNeedsReconciliation { await pushStateNow() }
        let revisionBeforePull = profileEditRevision
        guard let export = try? await backend.exportState() else { return false }
        guard revisionBeforePull == profileEditRevision else { return false }
        applyServerExport(export)
        if reconcilingConversation { conversationNeedsReconciliation = false }
        if let remoteRows = try? await backend.setupTaskRows() {
            for row in remoteRows where !runningTaskIDs.contains(row.task.id) {
                let task = row.task
                let previous = tasks.first(where: { $0.id == task.id })?.status
                if let index = tasks.firstIndex(where: { $0.id == task.id }) { tasks[index] = task }
                else { tasks.append(task) }
                if task.status == .succeeded, previous != .succeeded {
                    if task.kind == .signup { accountStates[task.siteID] = task.connectsExistingAccount ? .watching : .hasAccount }
                    if task.kind == .buildProfile { accountStates[task.siteID] = .watching }
                    if !activityEvents.contains(where: { $0.id == task.id }) { recordTaskEvent(task) }
                    // Queued work can finish while nobody awaits it:
                    // the same completion effects approveAndRun
                    // applies must land here too (both dedupe).
                    if task.kind == .discover, !row.extractedItems.isEmpty {
                        addDiscoveredOpportunities(items: row.extractedItems, task: task)
                    }
                    if task.kind == .apply, let oppID = task.opportunityID {
                        if let appIndex = applications.firstIndex(where: { $0.opportunityID == oppID }) {
                            applications[appIndex].stage = .submitted
                        }
                        setStatus(.applied, for: oppID)
                    }
                }
            }
        }
        for task in chatHelpTasks { surfaceTaskHelp(taskID: task.id, proactive: true) }
        await syncProfilePhoto()
        if let refs = try? await backend.listCredentialRefs() { credentialRefs = refs }
        if let memory = try? await backend.listSiteMemory(), !memory.memories.isEmpty {
            siteMemory = memory
        }
        writeCache()
        // A pull can be the moment the first notifiable thing
        // exists (a scan found work while the app was closed).
        await refreshNotificationPrimer()
        return true
    }

    func applyServerExport(_ export: ServerExport) {
        if let state = export.profile?.data, !pendingProfileEdit {
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
        let unsent = chatTranscript.first { $0.id == pendingConversationMessageID }
        chatTranscript = export.messages.map(\.data).sorted { $0.createdAt < $1.createdAt }
        if let unsent, !chatTranscript.contains(where: { $0.id == unsent.id }) { chatTranscript.append(unsent) }
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
        guard isBackendFirst, !conversationNeedsReconciliation, pendingConversationMessageID == nil else { return }
        pushTask?.cancel()
        pushTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            await self?.pushStateNow()
        }
    }

    private func pushStateNow() async {
        guard isBackendFirst, !conversationNeedsReconciliation, pendingConversationMessageID == nil else { return }
        let revision = profileEditRevision
        do {
            let result = try await backend.importState(currentImport())
            guard revision == profileEditRevision, !Task.isCancelled else { return }
            hasRealServerFeedItem = result.hasRealFeedItem
            if revision == profileEditRevision {
                pendingProfileEdit = false
                lastSyncError = nil
                writeCache()
            }
        } catch {
            guard revision == profileEditRevision, !Task.isCancelled else { return }
            let outcome = OfflineWritePolicy.outcome(reachable: false, requireCloud: BackendClient.requireCloud)
            if outcome == .failedUnreachable {
                lastSyncError = "Couldn't reach Hygge just now, so that last change is only on this phone for now. It hasn't been saved anywhere else yet."
                lastMessage = lastSyncError
            } else {
                lastSyncError = "You're offline, so that last change is only on this phone for now."
            }
        }
    }

    /// Called on each valid profile edit. The cache updates immediately; cloud
    /// sync is debounced and a pending edit cannot be replaced by a stale pull.
    func editProfile(_ edit: (inout EarningsProfile) -> Void) {
        edit(&profile)
        profileEditRevision += 1
        pendingProfileEdit = true
        lastSyncError = nil
        save()
    }

    func setProfilePhoto(_ data: Data?) {
        profilePhotoData = data
        profilePhotoRevision += 1
        profilePhotoNeedsUpload = true
        profilePhotoIsLegacy = false
        profilePhotoSyncError = nil
        writeCache()
        Task { await syncProfilePhoto() }
    }

    /// Serialize uploads so rapid photo selections cannot arrive out of order.
    /// Edits during a fetch/upload are handled by the next loop iteration.
    func syncProfilePhoto() async {
        if let photoSyncTask { await photoSyncTask.value; return }
        guard backend.hasSessionToken else { return }
        let epoch = profilePhotoAccountEpoch
        let task = Task<Void, Never> { [weak self] in
            guard let self else { return }
            await self.performPhotoSync(epoch: epoch)
            if epoch == self.profilePhotoAccountEpoch { self.photoSyncTask = nil }
        }
        photoSyncTask = task
        await task.value
    }

    private func performPhotoSync(epoch: Int) async {
        isSyncingProfilePhoto = true
        defer { if epoch == profilePhotoAccountEpoch { isSyncingProfilePhoto = false } }
        let userID = backend.sessionUserID
        let token = backend.apiToken
        func stillCurrent() -> Bool {
            !Task.isCancelled && epoch == profilePhotoAccountEpoch &&
                backend.sessionUserID == userID && backend.apiToken == token
        }
        while stillCurrent() {
            let revision = profilePhotoRevision
            do {
                if profilePhotoNeedsUpload {
                    if let data = profilePhotoData {
                        let uploaded = try await backend.uploadProfilePhoto(data, onlyIfMissing: profilePhotoIsLegacy)
                        guard stillCurrent() else { return }
                        guard revision == profilePhotoRevision else { continue }
                        if !uploaded {
                            let remote = try await backend.fetchProfilePhoto()
                            guard stillCurrent() else { return }
                            guard revision == profilePhotoRevision else { continue }
                            profilePhotoData = remote
                        }
                    } else {
                        try await backend.removeProfilePhoto()
                        guard stillCurrent() else { return }
                        guard revision == profilePhotoRevision else { continue }
                    }
                    profilePhotoNeedsUpload = false
                    profilePhotoIsLegacy = false
                } else {
                    let remote = try await backend.fetchProfilePhoto()
                    guard stillCurrent() else { return }
                    guard revision == profilePhotoRevision else { continue }
                    profilePhotoData = remote
                }
                profilePhotoSyncError = nil
                writeCache()
                return
            } catch {
                guard stillCurrent() else { return }
                if revision != profilePhotoRevision { continue }
                profilePhotoSyncError = profilePhotoNeedsUpload
                    ? "Your photo couldn’t be uploaded. It’s still saved on this phone."
                    : "Your photo couldn’t be refreshed just now."
                return
            }
        }
    }

    /// Feed presentation is local to this account cache. Archiving a card never
    /// cancels a task or answers a pending approval; it remains in Earlier.
    func setFeedArchived(_ id: String, archived: Bool) {
        if archived { archivedFeedIDs.insert(id) } else { archivedFeedIDs.remove(id) }
        writeCache()
    }

    /// Records that the person brought this task into chat themselves
    /// (swipe on its feed card). Only such tasks embed their browser
    /// in the conversation.
    func markTaskDiscussedInChat(taskID: UUID) {
        discussedTaskIDs.insert(taskID)
        writeCache()
    }

    func retryProfileSync() async { await pushStateNow() }

    // MARK: - Persistence

    private var storeURL: URL? {
        var filename = "hygge.json"
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--settings-preview") { filename = "hygge-settings-preview.json" }
        #endif
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent(filename)
    }

    /// Every local change lands in the cache, then pushes (Brief 01).
    private func save() {
        writeCache()
        schedulePush()
    }

    private func writeCache() {
        guard let url = storeURL else { return }
        var snapshot = StoreSnapshot(profile: profile, hasOnboarded: hasOnboarded, sites: sites,
                                     siteMemory: siteMemory, credentialRefs: credentialRefs,
                                     opportunities: opportunities, tasks: tasks, applications: applications,
                                     proposals: proposals, accountStates: accountStates,
                                     chatTranscript: chatTranscript, activityEvents: activityEvents, isPaused: isPaused, lastVisitAt: lastVisitAt, beliefs: beliefs, searchEvidence: searchEvidence, feedbackEvents: feedbackEvents, learningProfile: learningProfile)
        snapshot.archivedFeedIDs = archivedFeedIDs
        snapshot.discussedTaskIDs = discussedTaskIDs
        snapshot.profilePhotoData = profilePhotoData
        snapshot.profilePhotoNeedsUpload = profilePhotoNeedsUpload
        snapshot.profilePhotoIsLegacy = profilePhotoIsLegacy
        snapshot.pendingProfileEdit = pendingProfileEdit
        snapshot.pendingConversationMessageID = pendingConversationMessageID
        snapshot.pendingConversationGeneration = pendingConversationGeneration
        snapshot.conversationNeedsReconciliation = conversationNeedsReconciliation
        snapshot.clearedHelpIDs = clearedHelpIDs
        snapshot.lastConversationGeneration = lastConversationGeneration
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }

    private func load() -> Bool {
        guard let url = storeURL, let data = try? Data(contentsOf: url),
              let snapshot = try? JSONDecoder().decode(StoreSnapshot.self, from: data) else { return false }
        archivedFeedIDs = snapshot.archivedFeedIDs
        discussedTaskIDs = snapshot.discussedTaskIDs
        profile = snapshot.profile
        profilePhotoData = snapshot.profilePhotoData
        profilePhotoNeedsUpload = snapshot.profilePhotoNeedsUpload
        profilePhotoIsLegacy = snapshot.profilePhotoIsLegacy
        pendingProfileEdit = snapshot.pendingProfileEdit
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
        pendingConversationMessageID = snapshot.pendingConversationMessageID
        pendingConversationGeneration = snapshot.pendingConversationGeneration
        conversationNeedsReconciliation = snapshot.conversationNeedsReconciliation
        clearedHelpIDs = snapshot.clearedHelpIDs
        lastConversationGeneration = snapshot.lastConversationGeneration
        // First run after the badge learned to count unread: treat
        // history as read rather than badging the whole past.
        if UserDefaults.standard.object(forKey: "hygge.chatLastReadAt") == nil { markChatRead() }
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
