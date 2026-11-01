import Foundation

/// Brief 06 profile learning — the app-side mirror of the server model
/// in backend/cloudflare/src/learning.ts. The SERVER ranker is the one
/// ranking truth for what surfaces first; this file records the user's
/// decisions as structured feedback events (which sync to the user's
/// server state), keeps a local copy of the derived learning profile
/// for display, and defines stated-vs-inferred belief semantics.
/// Final values: docs/profile-learning.md.

public enum FeedbackSubjectType: String, Codable, Sendable {
    case opportunity, siteProposal, signup, application
}

public enum FeedbackAction: String, Codable, Sendable {
    case accepted, declined, ignored
    case approved, dismissed
    case signupApproved, profileConfirmed
    case sent, booked, completed
}

public enum FeedbackReason: String, Codable, Sendable {
    case tooLow, tooFar, notMyThing, justBusy, other

    /// Canonicalize what the feed already records: the "Not now" menu
    /// passes "too low" / "too far" / "not their thing" (its button
    /// reads "Not my thing") / "just busy".
    public static func from(uiString raw: String?) -> FeedbackReason? {
        guard let raw else { return nil }
        switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "": return nil
        case "too low": return .tooLow
        case "too far": return .tooFar
        case "not their thing", "not my thing": return .notMyThing
        case "just busy": return .justBusy
        default: return .other
        }
    }
}

/// One structured user decision. The id is a plain string: app-made
/// events use a UUID string, server-derived "ignored" events use a
/// deterministic "ignored:<opportunity id>" string.
public struct FeedbackEvent: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var subjectType: FeedbackSubjectType
    public var subjectId: String
    public var action: FeedbackAction
    public var reason: FeedbackReason?
    public var category: OpportunityCategory?
    public var requiredSkills: [String]
    public var estimatedHourly: Double?
    public var distanceKm: Double?
    public var occurredAt: Date

    public init(id: String = UUID().uuidString.lowercased(), subjectType: FeedbackSubjectType, subjectId: String,
                action: FeedbackAction, reason: FeedbackReason? = nil,
                category: OpportunityCategory? = nil, requiredSkills: [String] = [],
                estimatedHourly: Double? = nil, distanceKm: Double? = nil,
                occurredAt: Date = Date()) {
        self.id = id
        self.subjectType = subjectType
        self.subjectId = subjectId
        self.action = action
        self.reason = reason
        self.category = category
        self.requiredSkills = requiredSkills
        self.estimatedHourly = estimatedHourly
        self.distanceKm = distanceKm
        self.occurredAt = occurredAt
    }
}

public struct CategoryAffinity: Codable, Equatable, Sendable {
    public var score: Double // -1...1
    public var accepts: Int
    public var declines: Int
    public var ignores: Int
    public var updatedAt: Date?
    public init(score: Double = 0, accepts: Int = 0, declines: Int = 0,
                ignores: Int = 0, updatedAt: Date? = nil) {
        self.score = score
        self.accepts = accepts
        self.declines = declines
        self.ignores = ignores
        self.updatedAt = updatedAt
    }
}

/// The derived learning model, rebuilt from feedback events. Mirrors
/// the server deltas exactly (learning.ts FEEDBACK_DELTAS) so the
/// on-device display row and the server row agree. This type never
/// touches the rate floor.
public struct LearningProfile: Codable, Equatable, Sendable {
    public var id: String = "learning"
    /// Keyed by lowercase OpportunityCategory rawValue, exactly
    /// matching the server keys (learning.ts lowercases), so a
    /// server-built profile and local applies share one bucket.
    public var affinities: [String: CategoryAffinity] = [:]
    public var skillAffinities: [String: Double] = [:]
    public var rateSensitivity: Double = 0 // 0...1
    public var distanceSensitivity: Double = 0 // 0...1
    public var reasonCounts: [String: Int] = [:]
    public var tooLowDeclines: Int = 0
    public var eventCount: Int = 0
    public var updatedAt: Date?

    public init() {}

    public static let rateFloorPromptMinTooLow = 3
    /// Prompt affordance only — the floor changes solely when the user
    /// explicitly confirms a new one elsewhere.
    public var shouldPromptRateFloorReview: Bool {
        tooLowDeclines >= Self.rateFloorPromptMinTooLow
    }

    public func affinity(for category: OpportunityCategory) -> Double {
        affinities[category.rawValue.lowercased()]?.score
            ?? affinities[category.rawValue]?.score ?? 0
    }

    /// The one bucket for a category, under its lowercase server
    /// key. A legacy mixed-case bucket (written by an older build)
    /// is folded in rather than left as a divergent second score.
    private mutating func normalizedBucket(for category: OpportunityCategory) -> CategoryAffinity {
        let key = category.rawValue.lowercased()
        if let current = affinities[key] { return current }
        if key != category.rawValue, let legacy = affinities[category.rawValue] {
            affinities[category.rawValue] = nil
            return legacy
        }
        return CategoryAffinity()
    }

    /// Top affinities by absolute score, for "what Hygge has learned".
    public var topAffinities: [(OpportunityCategory, Double)] {
        affinities.compactMap { key, value in
            OpportunityCategory.allCases.first { $0.rawValue.lowercased() == key.lowercased() }
                .map { ($0, value.score) }
        }.sorted { abs($0.1) > abs($1.1) }
    }

    private static func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double {
        min(hi, max(lo, v))
    }

    public mutating func apply(_ event: FeedbackEvent) {
        func touch(_ delta: Double) {
            guard let category = event.category else { return }
            var a = normalizedBucket(for: category)
            a.score = Self.clamp(a.score + delta, -1, 1)
            a.updatedAt = event.occurredAt
            affinities[category.rawValue.lowercased()] = a
        }
        func count(_ field: (inout CategoryAffinity) -> Void) {
            guard let category = event.category else { return }
            var a = normalizedBucket(for: category)
            field(&a)
            affinities[category.rawValue.lowercased()] = a
        }
        func bumpSkills(_ delta: Double) {
            for skill in event.requiredSkills {
                let key = skill.trimmingCharacters(in: .whitespaces).lowercased()
                if !key.isEmpty { skillAffinities[key] = Self.clamp((skillAffinities[key] ?? 0) + delta, -1, 1) }
            }
        }
        switch event.action {
        case .accepted:
            touch(0.20); count { $0.accepts += 1 }; bumpSkills(0.10)
        case .declined:
            count { $0.declines += 1 }
            if let reason = event.reason { reasonCounts[reason.rawValue, default: 0] += 1 }
            switch event.reason {
            case .tooLow:
                touch(-0.05); rateSensitivity = Self.clamp(rateSensitivity + 0.20, 0, 1); tooLowDeclines += 1
            case .tooFar:
                touch(-0.05); distanceSensitivity = Self.clamp(distanceSensitivity + 0.20, 0, 1)
            case .notMyThing:
                touch(-0.30); bumpSkills(-0.15)
            case .justBusy:
                touch(-0.02)
            default:
                touch(-0.20)
            }
        case .ignored:
            touch(-0.05); count { $0.ignores += 1 }
        case .approved: touch(0.10)
        case .dismissed: touch(-0.10)
        case .signupApproved, .profileConfirmed: touch(0.10)
        case .sent: touch(0.15)
        case .booked: touch(0.20)
        case .completed: touch(0.25)
        }
        eventCount += 1
        updatedAt = event.occurredAt
    }

    public static func rebuilt(from events: [FeedbackEvent]) -> LearningProfile {
        var profile = LearningProfile()
        for event in events.sorted(by: { ($0.occurredAt, $0.id) < ($1.occurredAt, $1.id) }) {
            profile.apply(event)
        }
        return profile
    }
}

// MARK: - Beliefs: stated vs inferred (Brief 06 semantics)

public enum BeliefKind: String, Codable, Sendable {
    case stated, inferred
}

extension Belief {
    /// A belief the user said themselves (or rewrote via edit, which
    /// rewrites the source to youSaidIt) is stated. Learned/guessed
    /// origins are inferred until confirmed — see BeliefBook, where
    /// anything in `beliefs` was confirmed and `pending` was not.
    public var inferredKind: BeliefKind {
        source == .youSaidIt ? .stated : .inferred
    }
}

extension BeliefBook {
    public static let inferredHalfLifeDays: Double = 30
    public static let inferredExpiryConfidence: Double = 0.2

    /// Confirmed beliefs (in `beliefs`) and youSaidIt beliefs are
    /// stated; pending proposals are inferred.
    public func kind(of belief: Belief) -> BeliefKind {
        if belief.source == .youSaidIt { return .stated }
        return pending.contains { $0.id == belief.id } ? .inferred : .stated
    }

    /// Stated beliefs never decay. Inferred ones halve every 30 days.
    public func effectiveConfidence(of belief: Belief, at now: Date) -> Double {
        guard kind(of: belief) == .inferred else { return belief.confidence }
        let ageDays = max(0, now.timeIntervalSince(belief.learnedAt) / 86_400)
        return belief.confidence * pow(0.5, ageDays / Self.inferredHalfLifeDays)
    }

    public func isExpired(_ belief: Belief, at now: Date) -> Bool {
        kind(of: belief) == .inferred
            && effectiveConfidence(of: belief, at: now) < Self.inferredExpiryConfidence
    }

    /// Drop decayed-out inferred proposals. Stated beliefs stay.
    public mutating func pruneExpired(at now: Date) {
        let expired = Set(pending.filter { isExpired($0, at: now) }.map(\.id))
        pending.removeAll { expired.contains($0.id) }
    }
}
