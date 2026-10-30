import Foundation

// MARK: - Site proposals (agent suggests, user approves, agent figures it out)

public enum ProposalStatus: String, Codable, Sendable {
    case proposed, approvedSignup, approvedHasAccount, dismissed
}

public struct ProposedSite: Codable, Identifiable, Equatable, Sendable {
    public var id: UUID
    public var siteID: String
    public var rationale: String
    public var status: ProposalStatus
    public init(id: UUID = UUID(), siteID: String, rationale: String, status: ProposalStatus = .proposed) {
        self.id = id
        self.siteID = siteID
        self.rationale = rationale
        self.status = status
    }
}

public enum SiteAccountState: String, Codable, Sendable {
    case unknown, joining, hasAccount, profileLive
    public var label: String {
        switch self {
        case .unknown: return "Not joined yet"
        case .joining: return "Joining…"
        case .hasAccount: return "Account created/logged in"
        case .profileLive: return "Profile live"
        }
    }
}

public enum SiteProposals {
    private static func rationale(for site: TargetSite) -> String {
        switch site.category {
        case .petCare: return "Pet owners near you book sitters here — matches your pet-care interest."
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

    /// First-pass candidates for the user's interests. (The agent service
    /// can extend this live via /site-proposals; these seeds work offline.)
    public static func generate(profile: EarningsProfile, sites: [TargetSite]) -> [ProposedSite] {
        sites.filter { profile.interests.contains($0.category) }
            .map { ProposedSite(siteID: $0.id, rationale: rationale(for: $0)) }
    }
}

// MARK: - Conversational onboarding

public enum OnboardingStep: String, Codable, CaseIterable, Sendable {
    case welcome, name, categories, skills, location, payFloor, availability, email, permissions, summary, done

    public var prompt: String {
        switch self {
        case .welcome: return "Hi! I'm your Hygge agent. I'll find work across the internet for you — pet-sitting sites, freelance marketplaces, local gig boards, community groups — sign you up where it makes sense, and draft your applications. You approve everything before it happens. Ready?"
        case .name: return "Great. First, what should I call you?"
        case .categories: return "What kinds of work are you interested in? Pick any that sound good."
        case .skills: return "And what can you do? Pick your skills, or type your own."
        case .location: return "Where are you based? This helps me find local gigs near you. You can type it or share your location."
        case .payFloor: return "What's the lowest hourly rate you'd accept? I'll only surface work at or above it."
        case .availability: return "When are you usually available? (e.g. weekends, weekday evenings)"
        case .email: return "What's your email? I'll use it for account signups (passwords you set go in the encrypted vault, never in chat)."
        case .permissions: return "Three quick permissions so I can actually help: calendar (book gigs you approve), location (nearby work + travel time), and notifications (new matches, and when I need you for a login check). Each is optional."
        case .summary: return "Here's your earnings profile. Next I'll show you sites I'd suggest joining — you approve each one, then I'll figure out the signup on each site and ask you about anything I don't know."
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

/// One generated agent turn from the backend onboarding endpoint.
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
    /// Tailored by the LLM from everything said so far (empty = use presets).
    public var suggestedCategories: [OpportunityCategory] = []
    public var suggestedSkills: [String] = []
    public init() {}

    /// Merge an LLM turn: extracted facts land in the profile, suggestions
    /// replace the chip lists, and steps whose info already arrived (e.g. the
    /// user volunteered their city early) are skipped — the script stays in
    /// charge of *what* is collected, the model of *how it's said*.
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

    private func isAlreadySatisfied(_ step: OnboardingStep) -> Bool {
        switch step {
        case .name: return !profile.displayName.isEmpty
        case .location: return !profile.locationLabel.isEmpty
        case .availability: return !profile.availabilityNotes.isEmpty
        case .email: return profile.email.contains("@")
        default: return false // categories/skills always confirm with the user
        }
    }

    public var isFinished: Bool { step == .done }

    public mutating func advance() {
        let all = OnboardingStep.allCases
        guard var i = all.firstIndex(of: step) else { return }
        // Move forward, skipping steps whose information already arrived
        // (volunteered early in free text or extracted by the LLM).
        repeat {
            i += 1
            guard i < all.count else { return }
            step = all[i]
        } while isAlreadySatisfied(step)
    }

    /// Applies a free-text answer to the current step and moves on when valid.
    /// Returns false (and stays put) when the step needs more.
    @discardableResult
    public mutating func submitText(_ text: String) -> Bool {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        switch step {
        case .welcome:
            advance(); return true
        case .name:
            guard !value.isEmpty else { return false }
            profile.displayName = value
            if profile.headline.isEmpty { profile.headline = value }
            advance(); return true
        case .skills:
            if !value.isEmpty {
                for skill in value.split(separator: ",").map({ $0.trimmingCharacters(in: .whitespaces) })
                where !skill.isEmpty && !profile.skills.contains(skill) {
                    profile.skills.append(skill)
                }
            }
            guard !profile.skills.isEmpty else { return false }
            advance(); return true
        case .location:
            guard !value.isEmpty else { return false }
            profile.locationLabel = value
            advance(); return true
        case .payFloor:
            let digits = value.filter { $0.isNumber }
            if let rate = Double(digits), rate > 0 { profile.hourlyRateFloor = rate }
            advance(); return true
        case .availability:
            profile.availabilityNotes = value
            advance(); return true
        case .email:
            guard value.contains("@"), value.contains(".") else { return false }
            profile.email = value
            advance(); return true
        case .categories, .permissions, .summary:
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

    public mutating func confirmCategories() -> Bool {
        guard step == .categories, !profile.interests.isEmpty else { return false }
        advance(); return true
    }
}
