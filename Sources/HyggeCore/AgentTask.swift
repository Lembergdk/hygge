import Foundation

public enum AgentTaskKind: String, Codable, CaseIterable, Sendable {
    case discover, signup, buildProfile, apply, message, bookCalendar
    public var label: String {
        switch self {
        case .discover: return "Find opportunities"
        case .signup: return "Sign up"
        case .buildProfile: return "Build profile"
        case .apply: return "Apply"
        case .message: return "Send message"
        case .bookCalendar: return "Book calendar"
        }
    }
    /// Everything that changes state on a site (or the calendar) needs approval.
    public var requiresApproval: Bool { self != .discover }

    public var memoryKind: MemoryKind {
        switch self {
        case .discover: return .searchOpportunities
        case .signup: return .signup
        case .buildProfile: return .buildProfile
        case .apply: return .apply
        case .message: return .message
        case .bookCalendar: return .bookCalendar
        }
    }
}

public enum AgentTaskStatus: String, Codable, Sendable {
    case draft, awaitingApproval, approved, running, needsHuman, succeeded, failed, rejected
}

public enum AgentError: Error, Equatable {
    case notApproved
    case illegalTransition(from: AgentTaskStatus, to: AgentTaskStatus)
}

/// One unit of cloud-browser work: a natural-language goal on a target URL,
/// any advisory site memory it consulted, the approved draft payload (cover letter,
/// profile fields…), and the trace recorded when it ran.
public struct AgentTask: Codable, Identifiable, Equatable, Sendable {
    public var id: UUID
    public var kind: AgentTaskKind
    public var siteID: String
    public var targetURLString: String
    public var goal: String
    public var opportunityID: UUID?
    public var title: String
    public var draftedPayload: [String: String]
    public var memoryID: UUID?
    public var credentialRefID: UUID?
    /// The kept-open cloud-browser session for a task paused at a human
    /// check (CAPTCHA/2FA/ID). Resume continues in this same session;
    /// nil once the task finishes. An identifier only — never a secret.
    public var browserSessionID: String?
    public var browserTrace: [BrowserTraceEvent]
    public var informationRequests: [String]
    public var status: AgentTaskStatus
    public var log: [String]
    public var createdAt: Date

    public init(id: UUID = UUID(), kind: AgentTaskKind, siteID: String,
                targetURLString: String, goal: String,
                opportunityID: UUID? = nil, title: String,
                draftedPayload: [String: String] = [:],
                memoryID: UUID? = nil, credentialRefID: UUID? = nil,
                browserSessionID: String? = nil,
                browserTrace: [BrowserTraceEvent] = [], informationRequests: [String] = [],
                status: AgentTaskStatus = .awaitingApproval,
                log: [String] = [], createdAt: Date = Date()) {
        self.id = id
        self.kind = kind
        self.siteID = siteID
        self.targetURLString = targetURLString
        self.goal = goal
        self.opportunityID = opportunityID
        self.title = title
        self.draftedPayload = draftedPayload
        self.memoryID = memoryID
        self.credentialRefID = credentialRefID
        self.browserSessionID = browserSessionID
        self.browserTrace = browserTrace
        self.informationRequests = informationRequests
        self.status = status
        self.log = log
        self.createdAt = createdAt
    }

    public var domain: String {
        URL(string: targetURLString)?.host?.replacingOccurrences(of: "www.", with: "") ?? siteID
    }

    public mutating func approve() throws {
        guard status == .awaitingApproval || status == .draft else {
            throw AgentError.illegalTransition(from: status, to: .approved)
        }
        status = .approved
        log.append("Approved by user")
    }

    /// The user finished a CAPTCHA/2FA/ID check in the kept-open browser
    /// session: resume the same work. Distinct from approve() so the
    /// information-request path (requestReapproval) stays mandatory.
    public mutating func resume() throws {
        guard status == .needsHuman, informationRequests.isEmpty else {
            throw AgentError.illegalTransition(from: status, to: .approved)
        }
        status = .approved
        log.append("Resumed by user after completing the check")
    }

    /// After the user answers informationRequests, the mission goes back for
    /// a fresh approval before resuming.
    public mutating func requestReapproval() throws {
        guard status == .needsHuman else {
            throw AgentError.illegalTransition(from: status, to: .awaitingApproval)
        }
        status = .awaitingApproval
        log.append("User provided the requested information")
    }

    public mutating func reject() throws {
        guard status == .awaitingApproval || status == .draft || status == .needsHuman else {
            throw AgentError.illegalTransition(from: status, to: .rejected)
        }
        status = .rejected
        log.append("Rejected by user")
    }
}

/// Drafts browser tasks from the earnings profile. Drafting opens no browser.
public enum AgentTaskFactory {
    public static func applyTask(profile: EarningsProfile, opportunity: Opportunity) -> AgentTask {
        let skills = opportunity.requiredSkills.isEmpty
            ? profile.skills.prefix(3).joined(separator: ", ")
            : opportunity.requiredSkills.joined(separator: ", ")
        let letter = """
        Hi, I'm \(profile.displayName.isEmpty ? "a local helper" : profile.displayName) — \(profile.headline).

        I'd love to help with "\(opportunity.title)". Relevant experience: \(skills).
        \(profile.availabilityNotes.isEmpty ? "I'm generally available this week." : profile.availabilityNotes)

        Happy to answer questions or do a quick intro call. Thanks for considering me!
        """
        return AgentTask(
            kind: .apply, siteID: opportunity.siteID, targetURLString: opportunity.urlString,
            goal: "Open the listing \"\(opportunity.title)\", log in if needed, open the apply/contact flow, fill it with the approved cover letter, and submit. Stop for the user at any CAPTCHA, 2FA, payment or identity check.",
            opportunityID: opportunity.id,
            title: "Apply: \(opportunity.title)",
            draftedPayload: ["coverLetter": letter, "listingURL": opportunity.urlString,
                             "payLabel": opportunity.payLabel])
    }

    public static func discoverTask(profile: EarningsProfile, site: TargetSite) -> AgentTask {
        AgentTask(
            kind: .discover, siteID: site.id, targetURLString: site.startURLString,
            goal: site.goalTemplate,
            title: "Search \(site.name)",
            draftedPayload: ["searchTerms": profile.skills.joined(separator: " ")],
            status: .awaitingApproval)
    }

    public static func profileTask(profile: EarningsProfile, site: TargetSite) -> AgentTask {
        let bio = profile.bio.isEmpty
            ? "\(profile.headline). Skills: \(profile.skills.joined(separator: ", ")). Based in \(profile.locationLabel)."
            : profile.bio
        return AgentTask(
            kind: .buildProfile, siteID: site.id, targetURLString: site.startURLString,
            goal: "Log in to \(site.name), open profile/account settings, and fill headline, bio, skills and hourly rate from the approved draft. Save. Stop for the user at ID or background checks.",
            title: "Build \(site.name) profile",
            draftedPayload: ["profileHeadline": profile.headline, "profileBio": bio,
                             "hourlyRate": String(Int(profile.hourlyRateFloor)),
                             "skills": profile.skills.joined(separator: ", ")])
    }

    public static func signupTask(profile: EarningsProfile, site: TargetSite) -> AgentTask {
        AgentTask(
            kind: .signup, siteID: site.id, targetURLString: site.startURLString,
            goal: "Get the user set up on \(site.name). First figure out how this site works: is there a login that already works with the vault credential (existing account), or is a new signup needed? Work out what information the signup requires. Never invent personal data — if a required value is not in the approved draft, stop and ask the user for exactly what is missing. Stop for the user at email verification, CAPTCHA/bot checks, ID or background checks.",
            title: "Sign up for \(site.name)",
            draftedPayload: ["displayName": profile.displayName, "email": profile.email])
    }

    public static func customTask(site: TargetSite, goal: String, kind: AgentTaskKind = .discover) -> AgentTask {
        AgentTask(kind: kind, siteID: site.id, targetURLString: site.startURLString,
                  goal: goal, title: goal, draftedPayload: [:])
    }

    public static func bookCalendarTask(opportunity: Opportunity, when: Date) -> AgentTask {
        AgentTask(
            kind: .bookCalendar, siteID: opportunity.siteID, targetURLString: opportunity.urlString,
            goal: "Book \"\(opportunity.title)\" into the user's calendar.",
            opportunityID: opportunity.id,
            title: "Book: \(opportunity.title)",
            draftedPayload: ["eventTitle": opportunity.title,
                             "eventStartISO8601": ISO8601DateFormatter().string(from: when),
                             "location": opportunity.locationLabel])
    }
}

/// Local stand-in for the server-side mission loop, used when the agent
/// service is unreachable. Same contract as the real thing: NO step list.
/// Each iteration it observes the (simulated) page's elements, decides one
/// action from what it sees + the mission, executes, and re-observes.
/// Memory hints are passed in as advice; the loop works fine with none.
public struct SimulatedMissionRunner: Sendable {
    public init() {}

    public func run(_ task: AgentTask, repository: inout SiteMemoryRepository) throws -> AgentTask {
        var task = task
        if task.kind.requiresApproval {
            guard task.status == .approved else { throw AgentError.notApproved }
        }
        task.status = .running
        if task.kind == .bookCalendar {
            task.status = .succeeded
            task.log.append("Calendar booking handled on-device after approval.")
            return task
        }

        let hints = repository.hints(domain: task.domain, kind: task.kind.memoryKind)
        task.log.append(hints.isEmpty
            ? "Mission on \(task.domain) — new site, no memory yet. Exploring from the goal alone (simulated local runner)."
            : "Mission on \(task.domain) with \(hints.count) advisory memory hint(s) — deciding from the live page (simulated local runner).")

        if task.kind == .signup {
            var missing: [String] = []
            if (task.draftedPayload["phone"] ?? "").isEmpty {
                missing.append("What phone number should we use for verification texts on this site?")
            }
            if (task.draftedPayload["dateOfBirth"] ?? "").isEmpty {
                missing.append("What is your date of birth? (this site asks for it, likely for 18+ checks)")
            }
            if !missing.isEmpty {
                task.informationRequests = missing
                task.browserTrace.append(.init(action: .askUser, target: "", urlString: task.targetURLString,
                                               summary: "Agent needs information it cannot invent: " + missing.joined(separator: " "),
                                               succeeded: false))
                task.status = .needsHuman
                task.log.append("Paused: the agent needs information only you can provide (simulated local runner).")
                return task
            }
        }

        var labels = ["Log in / Sign in", "Sign up / Join", "Search field", "Search button",
                      "First listing card", "Apply / Contact", "Message / cover letter field"]
        var extracted = false
        for _ in 0..<14 {
            let decision = decide(task: task, labels: labels, history: task.browserTrace)
            switch decision.action {
            case .done:
                task.browserTrace.append(.init(action: .done, target: "", urlString: task.targetURLString,
                                               summary: decision.reason, succeeded: true))
                task.status = .succeeded
                let learned = repository.learn(domain: task.domain, kind: task.kind.memoryKind,
                                               trace: task.browserTrace, extractedCount: extracted ? 2 : 0)
                task.memoryID = learned?.id ?? task.memoryID
                task.log.append("Simulated mission complete. Connect the agent service for live LLM browsing.")
                return task
            case .extract:
                extracted = true
                task.browserTrace.append(.init(action: .extract, target: decision.target, urlString: task.targetURLString,
                                               summary: "Extracted 2: Weekend dog sitting — $45/night (simulated page) | Video editor wanted — $30/hr remote (simulated page) — \(decision.reason)", succeeded: true))
            case .type where decision.target.lowercased().contains("password"):
                task.browserTrace.append(.init(action: .type, target: decision.target, urlString: task.targetURLString,
                                               summary: "Credential injected from the server vault inside the browser worker (secret never shown to the app or model) — \(decision.reason)", succeeded: true))
            default:
                task.browserTrace.append(.init(action: decision.action, target: decision.target, urlString: task.targetURLString,
                                               summary: "\(decision.action.rawValue): \(decision.target) — \(decision.reason)", succeeded: true))
                labels = transition(labels: labels, action: decision.action, target: decision.target)
            }
        }
        task.status = .failed
        task.log.append("Simulated mission stopped: step budget exhausted.")
        return task
    }

    private struct Decision { var action: BrowserActionKind; var target: String; var reason: String }

    private func decide(task: AgentTask, labels: [String], history: [BrowserTraceEvent]) -> Decision {
        func has(_ subs: String...) -> String? { labels.first { l in subs.contains { l.lowercased().contains($0) } } }
        func did(_ action: BrowserActionKind, _ sub: String) -> Bool {
            history.contains { $0.action == action && $0.target.lowercased().contains(sub) }
        }
        let hasCredential = task.credentialRefID != nil
        if hasCredential, let pw = has("password"), !did(.type, "password") {
            if let user = has("email", "username"), !did(.type, "email") {
                return Decision(action: .type, target: user, reason: "login form visible")
            }
            return Decision(action: .type, target: pw, reason: "login form visible")
        }
        if hasCredential, let btn = has("log in button"), did(.type, "password") {
            return Decision(action: .click, target: btn, reason: "submit login")
        }
        if hasCredential, let link = has("log in / sign in"), has("password") == nil, !did(.click, "log in") {
            return Decision(action: .click, target: link, reason: "open login")
        }
        let extracted = history.contains { $0.action == .extract && $0.succeeded }
        if task.kind == .discover {
            if let search = has("search field"), !did(.type, "search") {
                return Decision(action: .type, target: search, reason: "search for the user's skills")
            }
            if !extracted { return Decision(action: .extract, target: "listings", reason: "read what is on the page") }
            return Decision(action: .done, target: "", reason: "listings extracted")
        }
        if let field = has("cover letter", "message"), !did(.type, "cover"), !did(.type, "message") {
            return Decision(action: .type, target: field, reason: "fill approved draft")
        }
        if let listing = has("first listing"), !did(.click, "listing") {
            return Decision(action: .click, target: listing, reason: "open the listing")
        }
        if let apply = has("apply / contact", "submit application"), !did(.click, "apply"), !did(.click, "submit") {
            return Decision(action: .click, target: apply, reason: "submit as approved")
        }
        if !extracted { return Decision(action: .extract, target: "page", reason: "understand the page") }
        return Decision(action: .done, target: "", reason: "mission actions completed")
    }

    private func transition(labels: [String], action: BrowserActionKind, target: String) -> [String] {
        guard action == .click else { return labels }
        let t = target.lowercased()
        if t.contains("log in / sign in") { return ["Email or username field", "Password field", "Log in button"] }
        if t.contains("log in button") {
            return ["Search field", "Search button", "First listing card", "Apply / Contact", "Message / cover letter field"]
        }
        if t.contains("first listing") { return ["Apply / Contact"] }
        if t.contains("apply / contact") { return ["Message / cover letter field", "Submit application"] }
        return labels
    }
}
