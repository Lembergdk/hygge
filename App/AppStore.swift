import Foundation
import Observation

struct StoreSnapshot: Codable {
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
    var lastMessage: String?

    let backend = BackendClient()
    private let localRunner = SimulatedMissionRunner()

    init() {
        if !load() {
            opportunities = SampleData.opportunities
        }
    }

    var pendingApprovalCount: Int { tasks.filter { $0.status == .awaitingApproval }.count }

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
        lastMessage = "I've suggested \(proposals.count) sites for you in the Sites tab. Approve the ones you like (or tell me where you already have an account) and I'll take it from there."
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
        lastMessage = alreadyHasAccount
            ? "Drafted a login + profile mission for \(site.name) in Approvals."
            : "Drafted a signup mission for \(site.name) in Approvals. The agent will work out the steps on the live site and ask you anything it doesn't know."
        save()
    }

    func dismissProposal(proposalID: UUID) {
        guard let index = proposals.firstIndex(where: { $0.id == proposalID }) else { return }
        proposals[index].status = .dismissed
        save()
    }

    func findMoreProposals() {
        let known = Set(proposals.map(\.siteID))
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
        for category in profile.interests {
            guard let found = try? await backend.siteProposals(category: category, profile: profile) else { continue }
            for dto in found {
                guard let site = TargetSite.userAdded(name: dto.name, urlOrDomain: dto.url, category: category) else { continue }
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
            lastMessage = "Credential for \(cleanDomain) stored in the server vault. The app keeps no copy of the password."
        } catch {
            lastMessage = "Could not reach the agent service, so nothing was stored. Start it with: cd backend/agent-service && node server.mjs"
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
        applications[index].stage = stage
        save()
    }

    // MARK: - Approval gate, then cloud-browser run with learning

    func approveAndRun(taskID: UUID) async {
        guard let index = tasks.firstIndex(where: { $0.id == taskID }) else { return }
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
            } else {
                task.log.append("Agent service unreachable — used the local simulated runner.")
                task = try localRunner.run(task, repository: &siteMemory)
            }

            if task.status == .succeeded {
                if task.kind == .signup { accountStates[task.siteID] = .hasAccount }
                if task.kind == .buildProfile { accountStates[task.siteID] = .profileLive }
            }
            if task.kind == .apply, task.status == .succeeded, let oppID = task.opportunityID {
                if let appIndex = applications.firstIndex(where: { $0.opportunityID == oppID }) {
                    applications[appIndex].stage = .submitted
                }
                setStatus(.applied, for: oppID)
            }
            tasks[index] = task
            lastMessage = task.status == .needsHuman ? "That step needs you — see the task log." : "Task finished: \(task.title)"
        } catch {
            lastMessage = "Could not run that task: \(error)"
        }
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
        save()
    }

    private func attachCredential(_ task: inout AgentTask) {
        task.credentialRefID = credential(forDomain: task.domain)?.id
    }

    private func attachSkill(_ task: inout AgentTask) {
        // Advisory only: the mission still starts from its goal + the live page.
        task.memoryID = siteMemory.memory(domain: task.domain, kind: task.kind.memoryKind)?.id
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
                                     proposals: proposals, accountStates: accountStates)
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
        return true
    }
}
