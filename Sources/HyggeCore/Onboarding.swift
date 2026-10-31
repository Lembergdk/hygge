import Foundation

// MARK: - Site proposals (agent suggests in context, user consents once)

public enum ProposalStatus: String, Codable, Sendable {
    case proposed, approvedSignup, approvedHasAccount, dismissed
}

public struct ProposedSite: Codable, Identifiable, Equatable, Sendable {
    public var id: UUID
    public var siteID: String
    public var rationale: String
    /// Specifics the consent card must name (design spec section 6.1).
    public var payPattern: String
    public var dataShared: String
    public var verification: String
    public var status: ProposalStatus
    public init(id: UUID = UUID(), siteID: String, rationale: String,
                payPattern: String = "Paid per job, rates vary by listing",
                dataShared: String = "Your name, photo and profile text",
                verification: String = "Email confirmation; a bot check may need you",
                status: ProposalStatus = .proposed) {
        self.id = id
        self.siteID = siteID
        self.rationale = rationale
        self.payPattern = payPattern
        self.dataShared = dataShared
        self.verification = verification
        self.status = status
    }
}

/// Per-site consent facts. Generic-rationale consent cards failed review;
/// known sites carry specifics, everything else falls back by category.
public enum ConsentCatalog {
    public static func details(for site: TargetSite) -> (pay: String, data: String, verification: String) {
        switch site.id {
        case "rover": return ("You set nightly/walk rates; owners pay through Rover",
                              "Name, photo, bio, service area and rates",
                              "Email + identity check and a profile review before you appear")
        case "trustedhousesitters": return ("No cash pay — stays are exchanged for pet/house care",
                              "Name, photo, bio, references if you add them",
                              "Paid membership, email and ID verification")
        case "pawshake": return ("You set per-visit rates; owners pay through Pawshake",
                              "Name, photo, bio and service area",
                              "Email confirmation; profile review")
        case "upwork": return ("Per-contract or hourly, clients pay through Upwork (their fee applies)",
                              "Name, photo, skills, work history you choose to show",
                              "Email, tax and identity verification before payouts")
        case "fiverr": return ("Fixed-price gig packages you define",
                              "Display name, skills and gig descriptions",
                              "Email confirmation; identity check before payouts")
        case "taskrabbit": return ("Hourly per task category, paid through Taskrabbit",
                              "Name, photo, skills, service area",
                              "Background check and identity verification")
        case "airtasker": return ("You bid per task; requesters pay through Airtasker",
                              "Name, photo, bio and skills",
                              "Email confirmation; payment identity checks")
        case "carecom": return ("Hourly, arranged with families; Care.com charges membership",
                              "Name, photo, experience and availability",
                              "Background check is standard for care work")
        default:
            switch site.category {
            case .petCare: return ("Per booking, paid via the platform", "Name, photo, bio and rates you set", "Email; expect a bot check or profile review")
            case .freelance, .creative, .remoteJob: return ("Per project or hourly, usually paid via the platform", "Name, skills and portfolio items you choose", "Email; identity/tax checks before payouts")
            case .community: return ("Arranged directly with people — no platform payout", "Only what you post publicly — drafts stay yours until approved", "Your existing account login; expect bot checks")
            default: return ("Per job, terms vary by listing", "Name, photo and a short profile", "Email confirmation; a bot check may need you")
            }
        }
    }
}

/// The full reconciled lifecycle of Hygge's relationship with one site.
/// `profileLive` is the legacy raw value for watching (kept so stored data
/// decodes); new code writes `watching`.
public enum SiteAccountState: String, Codable, Sendable {
    case unknown, proposed, joining, needsVerification, hasAccount, profileLive, watching, paused, stopped, disconnected
    public var label: String {
        switch self {
        case .unknown: return "Not joined yet"
        case .proposed: return "Suggested"
        case .joining: return "Joining…"
        case .needsVerification: return "Needs a check by you"
        case .hasAccount: return "Account ready"
        case .profileLive, .watching: return "Watching for work"
        case .paused: return "Paused"
        case .stopped: return "Stopped watching"
        case .disconnected: return "Disconnected"
        }
    }
    public var isWatching: Bool { self == .watching || self == .profileLive }
    /// Suggestions must never resurrect a site the user cut off.
    public var blocksSuggestions: Bool { self == .stopped || self == .disconnected }
}

public enum SiteProposals {
    private static func rationale(for site: TargetSite) -> String {
        switch site.category {
        case .petCare: return "Pet owners near you book sitters here — matches the work you enjoy."
        case .freelance: return "Clients hire freelancers with your skills here."
        case .localGig: return "Local paid tasks people post every day."
        case .homeServices: return "Homeowners looking for local help."
        case .tutoring: return "Families looking for tutors and carers."
        case .creative: return "Buyers looking for creative work."
        case .delivery: return "Delivery work with flexible hours."
        case .remoteJob: return "Remote/part-time roles matching your skills."
        case .community: return "People in local groups frequently ask for exactly this kind of help."
        }
    }

    public static func generate(profile: EarningsProfile, sites: [TargetSite]) -> [ProposedSite] {
        sites.filter { profile.interests.contains($0.category) }
            .map { site in
                let d = ConsentCatalog.details(for: site)
                return ProposedSite(siteID: site.id, rationale: rationale(for: site),
                                    payPattern: d.pay, dataShared: d.data, verification: d.verification)
            }
    }
}

// MARK: - Fee (single configurable rate; shown as its own line at money moments)

public enum HyggeFee {
    /// The rate shown while pricing is decided. isFinalized stays false until
    /// the business model (rate + who processes payment) is settled; UI must
    /// never present this fee as already deducted while it is false.
    public static let isFinalized = false
    public static let rate: Double = 0.15
    public static func breakdown(gross: Double) -> (fee: Double, net: Double) {
        let fee = (gross * rate * 100).rounded() / 100
        return (fee, ((gross - fee) * 100).rounded() / 100)
    }
    public static var percentLabel: String { "\(Int(rate * 100))%" }
}

// MARK: - Time saved (always "about", always with its math, rounded down)

public enum TimeSaved {
    public static let minutesPerListing = 3
    public static let minutesPerDraft = 10
    public static let minutesPerSearchRun = 15

    public static func estimatedMinutes(listingsRead: Int, draftsWritten: Int, searchRuns: Int) -> Int {
        listingsRead * minutesPerListing + draftsWritten * minutesPerDraft + searchRuns * minutesPerSearchRun
    }

    /// One cozy afternoon ≈ two hours, per the design language.
    public static func cozyAfternoons(minutes: Int) -> Int { minutes / 120 }

    /// "About 2 hours" / "About 40 minutes" — rounded DOWN to a defensible figure.
    public static func aboutLabel(minutes: Int) -> String {
        if minutes <= 0 { return "none yet" }
        if minutes < 10 { return "a few minutes" }
        if minutes < 60 { return "about \(minutes / 10 * 10) minutes" }
        let hours = Double(minutes) / 60.0
        let roundedDown = floor(hours * 2) / 2
        if roundedDown == 1 { return "about 1 hour" }
        if roundedDown.truncatingRemainder(dividingBy: 1) == 0 { return "about \(Int(roundedDown)) hours" }
        return "about \(roundedDown) hours"
    }
}

// MARK: - The one continuous conversation thread

public struct ChatEntry: Codable, Identifiable, Equatable, Sendable {
    public var id: UUID
    public var fromAgent: Bool
    public var text: String
    public var createdAt: Date
    public init(id: UUID = UUID(), fromAgent: Bool, text: String, createdAt: Date = Date()) {
        self.id = id
        self.fromAgent = fromAgent
        self.text = text
        self.createdAt = createdAt
    }
}

// MARK: - First run: three questions, inside the same thread

public enum OnboardingStep: String, Codable, CaseIterable, Sendable {
    case welcome, enjoyWork, lowestRate, whereWhen, summary, done

    public var prompt: String {
        switch self {
        case .welcome: return "Hygge — \"hoo-gah\". Danish for cozy time with the people you love. That is what the money is for. I'll find work across the internet, draft everything, and only tap you on the shoulder when a decision is really yours. Ready?"
        case .enjoyWork: return "What kinds of work do you actually enjoy? Tap any that fit, or just tell me."
        case .lowestRate: return "What's your lowest rate? Anything below it, I'll quietly drop — you'll never see it."
        case .whereWhen: return "Roughly where are you, and when are you free? It keeps local work close and stops double-bookings."
        case .summary: return "That's all I need to start. I'll look overnight and tell you in the morning — sooner if something needs you."
        case .done: return "You're set up!"
        }
    }
}

/// Facts the onboarding LLM extracted from free text (any step, any order).
public struct EarningsProfilePatch: Codable, Equatable, Sendable {
    public var displayName: String?
    public var headline: String?
    public var interests: [OpportunityCategory]?
    public var skills: [String]?
    public var locationLabel: String?
    public var hourlyRateFloor: Double?
    public var availabilityNotes: String?
    public var email: String?
    public init(displayName: String? = nil, headline: String? = nil,
                interests: [OpportunityCategory]? = nil, skills: [String]? = nil,
                locationLabel: String? = nil, hourlyRateFloor: Double? = nil,
                availabilityNotes: String? = nil, email: String? = nil) {
        self.displayName = displayName
        self.headline = headline
        self.interests = interests
        self.skills = skills
        self.locationLabel = locationLabel
        self.hourlyRateFloor = hourlyRateFloor
        self.availabilityNotes = availabilityNotes
        self.email = email
    }
}

/// One generated agent turn from the backend onboarding/chat endpoint.
public struct OnboardingAssistantReply: Codable, Equatable, Sendable {
    public var reply: String
    public var extracted: EarningsProfilePatch
    public var suggestedCategories: [OpportunityCategory]
    public var suggestedSkills: [String]
    public var simulated: Bool?
    public init(reply: String, extracted: EarningsProfilePatch = EarningsProfilePatch(),
                suggestedCategories: [OpportunityCategory] = [], suggestedSkills: [String] = [],
                simulated: Bool? = nil) {
        self.reply = reply
        self.extracted = extracted
        self.suggestedCategories = suggestedCategories
        self.suggestedSkills = suggestedSkills
        self.simulated = simulated
    }
}

public struct OnboardingConversation: Equatable, Sendable {
    public var step: OnboardingStep = .welcome
    public var profile = EarningsProfile()
    public var suggestedCategories: [OpportunityCategory] = []
    public var suggestedSkills: [String] = []
    public init() {}

    public var isFinished: Bool { step == .done }

    /// Truthful progress: only the three real questions count.
    public var questionNumber: Int? {
        switch step {
        case .enjoyWork: return 1
        case .lowestRate: return 2
        case .whereWhen: return 3
        default: return nil
        }
    }

    public var canGoBack: Bool { step != .welcome && step != .done }

    public mutating func goBack() {
        let all = OnboardingStep.allCases
        guard let i = all.firstIndex(of: step), i > 0, step != .done else { return }
        step = all[i - 1]
    }

    public mutating func advance() {
        let all = OnboardingStep.allCases
        guard var i = all.firstIndex(of: step) else { return }
        repeat {
            i += 1
            guard i < all.count else { return }
            step = all[i]
        } while isAlreadySatisfied(step)
    }

    private func isAlreadySatisfied(_ step: OnboardingStep) -> Bool {
        switch step {
        case .enjoyWork: return false // taste always confirms with the user
        case .whereWhen: return !profile.locationLabel.isEmpty && !profile.availabilityNotes.isEmpty
        default: return false
        }
    }

    @discardableResult
    public mutating func submitText(_ text: String) -> Bool {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        switch step {
        case .welcome:
            advance(); return true
        case .enjoyWork:
            if !value.isEmpty {
                if profile.bio.isEmpty { profile.bio = value }
                for part in value.split(separator: ",").map({ $0.trimmingCharacters(in: .whitespaces) })
                where part.count > 2 && part.count < 40 && !profile.skills.contains(part) {
                    profile.skills.append(part)
                }
            }
            guard !profile.interests.isEmpty || !value.isEmpty else { return false }
            advance(); return true
        case .lowestRate:
            let digits = value.filter { $0.isNumber }
            if let rate = Double(digits), rate > 0 { profile.hourlyRateFloor = rate }
            advance(); return true
        case .whereWhen:
            if !value.isEmpty { profile.locationLabel = value }
            guard !profile.locationLabel.isEmpty else { return false }
            advance(); return true
        case .summary:
            advance(); return true
        case .done:
            return true
        }
    }

    public mutating func toggleCategory(_ category: OpportunityCategory) {
        if profile.interests.contains(category) {
            profile.interests.removeAll { $0 == category }
        } else {
            profile.interests.append(category)
        }
    }

    public mutating func toggleSkill(_ skill: String) {
        if profile.skills.contains(skill) {
            profile.skills.removeAll { $0 == skill }
        } else {
            profile.skills.append(skill)
        }
    }

    public mutating func confirmEnjoyWork() -> Bool {
        guard step == .enjoyWork, !profile.interests.isEmpty else { return false }
        advance(); return true
    }

    /// Merge an LLM turn: extracted facts land in the profile, suggestions
    /// replace chip lists. The script owns WHAT is collected; the model owns
    /// how it's said and what it infers.
    public mutating func applyAssistant(_ reply: OnboardingAssistantReply) {
        let patch = reply.extracted
        if let v = patch.displayName, !v.isEmpty { profile.displayName = v }
        if let v = patch.headline, !v.isEmpty { profile.headline = v }
        for category in patch.interests ?? [] where !profile.interests.contains(category) {
            profile.interests.append(category)
        }
        for skill in patch.skills ?? [] where !skill.isEmpty && !profile.skills.contains(skill) {
            profile.skills.append(skill)
        }
        if let v = patch.locationLabel, !v.isEmpty { profile.locationLabel = v }
        if let v = patch.hourlyRateFloor, v > 0 { profile.hourlyRateFloor = v }
        if let v = patch.availabilityNotes, !v.isEmpty { profile.availabilityNotes = v }
        if let v = patch.email, v.contains("@") { profile.email = v }
        if !reply.suggestedCategories.isEmpty { suggestedCategories = reply.suggestedCategories }
        if !reply.suggestedSkills.isEmpty { suggestedSkills = reply.suggestedSkills }
    }
}
