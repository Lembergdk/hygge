import Foundation

public enum OpportunityCategory: String, Codable, CaseIterable, Identifiable, Sendable {
    case petCare, freelance, localGig, delivery, creative, tutoring, homeServices, remoteJob, community
    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .petCare: return "Pet care"
        case .freelance: return "Freelance"
        case .localGig: return "Local gigs"
        case .delivery: return "Delivery & driving"
        case .creative: return "Creative"
        case .tutoring: return "Tutoring & care"
        case .homeServices: return "Home services"
        case .remoteJob: return "Remote jobs"
        case .community: return "Communities"
        }
    }
    /// Plain activity language for onboarding — what you'd say out loud,
    /// not internal taxonomy.
    public var activityLabel: String {
        switch self {
        case .petCare: return "Looking after pets"
        case .freelance: return "Freelance projects online"
        case .localGig: return "Odd jobs nearby"
        case .delivery: return "Deliveries & driving"
        case .creative: return "Making things — design, writing, video"
        case .tutoring: return "Teaching & caring"
        case .homeServices: return "Helping in homes & gardens"
        case .remoteJob: return "Remote part-time work"
        case .community: return "Helping people in local groups"
        }
    }
    /// Short tile form — must fit a two-column tile without truncation.
    public var tileLabel: String {
        switch self {
        case .petCare: return "Pet care"
        case .freelance: return "Freelance"
        case .localGig: return "Odd jobs"
        case .delivery: return "Deliveries"
        case .creative: return "Creative"
        case .tutoring: return "Teaching"
        case .homeServices: return "Home help"
        case .remoteJob: return "Remote work"
        case .community: return "Local groups"
        }
    }
}

/// The user's unified earnings profile. Platform profiles are drafts derived from this.
public struct EarningsProfile: Codable, Equatable, Sendable {
    public var displayName: String
    public var headline: String
    public var skills: [String]
    public var interests: [OpportunityCategory]
    public var hourlyRateFloor: Double
    public var locationLabel: String
    public var radiusKm: Double
    public var remoteOK: Bool
    public var hasCar: Bool
    public var availabilityNotes: String
    public var bio: String
    public var email: String

    public init(displayName: String = "", headline: String = "", skills: [String] = [],
                interests: [OpportunityCategory] = [], hourlyRateFloor: Double = 25,
                locationLabel: String = "", radiusKm: Double = 20, remoteOK: Bool = true,
                hasCar: Bool = false, availabilityNotes: String = "", bio: String = "", email: String = "") {
        self.displayName = displayName
        self.headline = headline
        self.skills = skills
        self.interests = interests
        self.hourlyRateFloor = hourlyRateFloor
        self.locationLabel = locationLabel
        self.radiusKm = radiusKm
        self.remoteOK = remoteOK
        self.hasCar = hasCar
        self.availabilityNotes = availabilityNotes
        self.bio = bio
        self.email = email
    }

    /// First run collects only three things; name/skills arrive progressively.
    public var isComplete: Bool {
        !interests.isEmpty && !locationLabel.trimmingCharacters(in: .whitespaces).isEmpty
    }
}

public enum SkillPresets {
    public static let all: [String] = [
        "Dog walking", "Pet sitting", "Cat care", "House sitting",
        "Writing", "Graphic design", "Video editing", "Web development",
        "Social media", "Bookkeeping", "Tutoring (maths)", "Tutoring (English)",
        "Cleaning", "Gardening", "Furniture assembly", "Moving help",
        "Delivery driving", "Photography", "Childcare", "Elderly care"
    ]
}

public enum OpportunityStatus: String, Codable, Sendable {
    case new, saved, dismissed, applied
}

public struct Opportunity: Codable, Identifiable, Equatable, Sendable {
    public var id: UUID
    public var siteID: String
    public var title: String
    public var summary: String
    public var category: OpportunityCategory
    public var payLabel: String
    public var estimatedHourly: Double?
    /// Structured gross for fixed-price work, when actually known. Accounting
    /// uses ONLY structured amounts like this (never parsed label text).
    public var estimatedGross: Double?
    public var currencyCode: String
    public var locationLabel: String
    public var isRemote: Bool
    public var requiredSkills: [String]
    public var urlString: String
    public var isDemo: Bool
    public var status: OpportunityStatus

    public init(id: UUID = UUID(), siteID: String, title: String, summary: String,
                category: OpportunityCategory, payLabel: String, estimatedHourly: Double?,
                locationLabel: String, isRemote: Bool, requiredSkills: [String],
                urlString: String, estimatedGross: Double? = nil, currencyCode: String = "USD",
                isDemo: Bool = false, status: OpportunityStatus = .new) {
        self.id = id
        self.siteID = siteID
        self.title = title
        self.summary = summary
        self.category = category
        self.payLabel = payLabel
        self.estimatedHourly = estimatedHourly
        self.estimatedGross = estimatedGross
        self.currencyCode = currencyCode
        self.locationLabel = locationLabel
        self.isRemote = isRemote
        self.requiredSkills = requiredSkills
        self.urlString = urlString
        self.isDemo = isDemo
        self.status = status
    }
}

public enum ApplicationStage: String, Codable, CaseIterable, Sendable {
    case drafted, submitted, interviewing, booked, completed, rejected
    public var label: String { rawValue.capitalized }
}

public struct ApplicationRecord: Codable, Identifiable, Equatable, Sendable {
    public var id: UUID
    public var opportunityID: UUID
    public var siteID: String
    public var title: String
    public var stage: ApplicationStage
    public var createdAt: Date
    /// Actual gross pay, recorded when the work completes (witnessed, entered
    /// by the user or confirmed from the platform) — the only money that counts.
    public var agreedGross: Double?
    public var currencyCode: String

    public init(id: UUID = UUID(), opportunityID: UUID, siteID: String, title: String,
                stage: ApplicationStage = .drafted, createdAt: Date = Date(),
                agreedGross: Double? = nil, currencyCode: String = "USD") {
        self.id = id
        self.opportunityID = opportunityID
        self.siteID = siteID
        self.title = title
        self.stage = stage
        self.createdAt = createdAt
        self.agreedGross = agreedGross
        self.currencyCode = currencyCode
    }
}


/// A witnessed thing that actually happened, recorded at the moment it
/// happened. Journal, earnings and time-saved derive ONLY from these —
/// never reconstructed from mutable task/application state after the fact.
public struct ActivityEvent: Codable, Identifiable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case searchedSite, joinedSite, profileLive, applicationSent, messageSent, booked, workCompleted, learnedAboutSite
    }
    public var id: UUID
    public var occurredAt: Date
    public var kind: Kind
    public var sentence: String
    public var detail: String
    public var siteID: String?
    public var applicationID: UUID?
    public var grossAmount: Double?
    public var currencyCode: String
    public var listingsChecked: Int
    public init(id: UUID = UUID(), occurredAt: Date = Date(), kind: Kind, sentence: String,
                detail: String = "", siteID: String? = nil, applicationID: UUID? = nil,
                grossAmount: Double? = nil, currencyCode: String = "USD", listingsChecked: Int = 0) {
        self.id = id
        self.occurredAt = occurredAt
        self.kind = kind
        self.sentence = sentence
        self.detail = detail
        self.siteID = siteID
        self.applicationID = applicationID
        self.grossAmount = grossAmount
        self.currencyCode = currencyCode
        self.listingsChecked = listingsChecked
    }
}
