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

    public var isComplete: Bool {
        !displayName.trimmingCharacters(in: .whitespaces).isEmpty && !skills.isEmpty && !interests.isEmpty
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
    public var locationLabel: String
    public var isRemote: Bool
    public var requiredSkills: [String]
    public var urlString: String
    public var isDemo: Bool
    public var status: OpportunityStatus

    public init(id: UUID = UUID(), siteID: String, title: String, summary: String,
                category: OpportunityCategory, payLabel: String, estimatedHourly: Double?,
                locationLabel: String, isRemote: Bool, requiredSkills: [String],
                urlString: String, isDemo: Bool = false, status: OpportunityStatus = .new) {
        self.id = id
        self.siteID = siteID
        self.title = title
        self.summary = summary
        self.category = category
        self.payLabel = payLabel
        self.estimatedHourly = estimatedHourly
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

    public init(id: UUID = UUID(), opportunityID: UUID, siteID: String, title: String,
                stage: ApplicationStage = .drafted, createdAt: Date = Date()) {
        self.id = id
        self.opportunityID = opportunityID
        self.siteID = siteID
        self.title = title
        self.stage = stage
        self.createdAt = createdAt
    }
}
