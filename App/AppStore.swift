import Foundation
import Observation

struct StoreSnapshot: Codable {
    init(profile: EarningsProfile, hasOnboarded: Bool, sites: [TargetSite],
         siteMemory: SiteMemoryRepository, credentialRefs: [CredentialRef],
         opportunities: [Opportunity], tasks: [AgentTask], applications: [ApplicationRecord],
         proposals: [ProposedSite], accountStates: [String: SiteAccountState],
         chatTranscript: [ChatEntry], activityEvents: [ActivityEvent], isPaused: Bool,
         lastVisitAt: Date?, beliefs: BeliefBook = BeliefBook(), searchEvidence: [SearchEvidence] = []) {
        self.profile = profile; self.hasOnboarded = hasOnboarded; self.sites = sites
        self.siteMemory = siteMemory; self.credentialRefs = credentialRefs
        self.opportunities = opportunities; self.tasks = tasks; self.applications = applications
        self.proposals = proposals; self.accountStates = accountStates
        self.chatTranscript = chatTranscript; self.activityEvents = activityEvents
        self.isPaused = isPaused; self.lastVisitAt = lastVisitAt
        self.beliefs = beliefs; self.searchEvidence = searchEvidence
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
    var lastVisitAt: Date?
    /// Captured at launch: journal grouping is 'since' this moment.
    var visitMarker: Date = .distantPast
    var lastMessage: String?

    let backend = BackendClient()
    private let localRunner = SimulatedMissionRunner()

    init() {
        if !load() {
            opportunities = SampleData.opportunities
        }
        visitMarker = lastVisitAt ?? .distantPast
        lastVisitAt = Date()
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

    var rankedOpportunities: [(Opportunity, MatchResult)] {
        MatchEngine.ranked(profile: profile,
                           opportunities: opportunities.filter { $0.status != .dismissed })
    }

    func site(id: String) -> TargetSite? { sites.first { $0.id == id } }
    func siteName(id: String) -> String { site(id: id)?.name ?? id }

    func credential(forDomain domain: String) -> CredentialRef? {
        credentialRefs.first { $0.domain == domain }
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
        accountStates[site.id] = .joining
        var task = alreadyHasAccount
            ? AgentTaskFactory.profileTask(profile: profile, site: site)
            : AgentTaskFactory.signupTask(profile: profile, site: site)
        attachCredential(&task)
        attachSkill(&task)
        tasks.append(task)
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

    func dismissProposal(proposalID: UUID) {
        guard let index = proposals.firstIndex(where: { $0.id == proposalID }) else { return }
        proposals[index].status = .dismissed
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
    func addCredential(domain: String, username: String, secret: String) async {
        let cleanDomain = domain.replacingOccurrences(of: "www.", with: "")
            .replacingOccurrences(of: "https://", with: "")
            .replacingOccurrences(of: "http://", with: "")
        do {
            let ref = try await backend.storeCredential(domain: cleanDomain, username: username, secret: secret)
            credentialRefs.append(ref)
            lastMessage = "Login for \(cleanDomain) saved safely. This phone keeps no copy of the password."
        } catch {
            lastMessage = "That login could not be saved just now. Nothing was stored — please try again in a moment."
        }
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
        var task = AgentTaskFactory.signupTask(profile: profile, site: site)
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
        case .buildProfile:
            recordEvent(ActivityEvent(kind: .profileLive, sentence: "Your \(site) profile is live.", siteID: task.siteID))
        case .apply:
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
            try tasks[index].approve()
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

    func reject(taskID: UUID) {
        guard let index = tasks.firstIndex(where: { $0.id == taskID }) else { return }
        try? tasks[index].reject()
        save()
    }

    func updatePayload(taskID: UUID, key: String, value: String) {
        guard let index = tasks.firstIndex(where: { $0.id == taskID }) else { return }
        tasks[index].draftedPayload[key] = value
        save()
    }

    func resetAll() {
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
        isPaused = false
        save()
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
    func confirmBelief(id: UUID) { beliefs.confirm(proposalID: id); save() }
    func rejectBelief(id: UUID) { beliefs.reject(proposalID: id); save() }
    func editBelief(id: UUID, sentence: String) { beliefs.edit(beliefID: id, sentence: sentence); save() }
    func deleteBelief(id: UUID) { beliefs.delete(beliefID: id); save() }

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

    // MARK: - Persistence

    private var storeURL: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("hygge.json")
    }

    private func save() {
        guard let url = storeURL else { return }
        let snapshot = StoreSnapshot(profile: profile, hasOnboarded: hasOnboarded, sites: sites,
                                     siteMemory: siteMemory, credentialRefs: credentialRefs,
                                     opportunities: opportunities, tasks: tasks, applications: applications,
                                     proposals: proposals, accountStates: accountStates,
                                     chatTranscript: chatTranscript, activityEvents: activityEvents, isPaused: isPaused, lastVisitAt: lastVisitAt, beliefs: beliefs, searchEvidence: searchEvidence)
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
        lastVisitAt = snapshot.lastVisitAt
        return true
    }
}
