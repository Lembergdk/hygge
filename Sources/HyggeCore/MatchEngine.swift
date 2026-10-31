import Foundation

public struct MatchResult: Equatable, Sendable {
    /// 0...1
    public var score: Double
    public var reasons: [String]
    /// Concrete, checkable facts (rate vs floor, place, skills) shown on the
    /// approval card regardless of whether a recommendation is made.
    public var evidence: [String]
    public init(score: Double, reasons: [String], evidence: [String] = []) {
        self.score = score
        self.reasons = reasons
        self.evidence = evidence
    }
    public var percent: Int { Int((score * 100).rounded()) }
    /// Graded honesty: the same number, named as confidence where it gates
    /// what Hygge is willing to recommend.
    public var confidence: Double { score }
}

/// Negative-space evidence from one look at a site: everything read, what
/// was kept, and — crucially — what was dropped and why, so the journal can
/// tell the truth about work the user never saw.
public struct SearchEvidence: Codable, Identifiable, Equatable, Sendable {
    public struct Dropped: Codable, Equatable, Sendable {
        public var title: String
        public var reason: String
        public init(title: String, reason: String) {
            self.title = title
            self.reason = reason
        }
    }
    public var id: UUID
    public var siteID: String
    public var recordedAt: Date
    public var listingsRead: Int
    public var keptTitles: [String]
    public var borderlineTitles: [String]
    public var dropped: [Dropped]

    public init(id: UUID = UUID(), siteID: String, recordedAt: Date = Date(),
                listingsRead: Int, keptTitles: [String], borderlineTitles: [String],
                dropped: [Dropped]) {
        self.id = id
        self.siteID = siteID
        self.recordedAt = recordedAt
        self.listingsRead = listingsRead
        self.keptTitles = keptTitles
        self.borderlineTitles = borderlineTitles
        self.dropped = dropped
    }

    private static func word(_ n: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .spellOut
        return formatter.string(from: NSNumber(value: n)) ?? "\(n)"
    }

    /// "Read fourteen listings, dropped twelve below your floor, two are ready."
    public var journalSentence: String {
        var sentence = "Read \(Self.word(listingsRead)) listing\(listingsRead == 1 ? "" : "s")"
        if !dropped.isEmpty {
            let belowFloor = dropped.filter { $0.reason.contains("floor") }.count
            let detail = belowFloor == dropped.count ? " below your floor" : ""
            sentence += ", dropped \(Self.word(dropped.count))\(detail)"
        }
        if keptTitles.isEmpty {
            sentence += ", nothing new worth your attention."
        } else {
            sentence += ", \(Self.word(keptTitles.count)) \(keptTitles.count == 1 ? "is" : "are") ready."
        }
        return sentence
    }
}

public enum MatchEngine {
    public static func evaluate(profile: EarningsProfile, opportunity: Opportunity) -> MatchResult {
        var score = 0.0
        var reasons: [String] = []

        // Category interest: 0.35
        if profile.interests.contains(opportunity.category) {
            score += 0.35
            reasons.append("Matches your \(opportunity.category.label) interest")
        }

        // Skill overlap: up to 0.35
        let mine = Set(profile.skills.map { $0.lowercased() })
        let needed = opportunity.requiredSkills
        if needed.isEmpty {
            score += 0.15
            reasons.append("No specific skills required")
        } else {
            let hits = needed.filter { mine.contains($0.lowercased()) }
            score += 0.35 * Double(hits.count) / Double(needed.count)
            if !hits.isEmpty {
                reasons.append("Uses your skills: \(hits.joined(separator: ", "))")
            } else {
                reasons.append("Needs skills you have not listed: \(needed.joined(separator: ", "))")
            }
        }

        // Pay vs floor: up to 0.2
        if let hourly = opportunity.estimatedHourly {
            if hourly >= profile.hourlyRateFloor {
                score += 0.2
                reasons.append("Pay meets your $\(Int(profile.hourlyRateFloor))/hr floor")
            } else if hourly >= profile.hourlyRateFloor * 0.8 {
                score += 0.08
                reasons.append("Pay is slightly below your floor")
            } else {
                reasons.append("Pay is below your floor")
            }
        }

        // Remote fit: 0.1
        if opportunity.isRemote {
            if profile.remoteOK {
                score += 0.1
                reasons.append("Remote")
            }
        } else {
            score += 0.05
            reasons.append("In person near \(opportunity.locationLabel)")
        }

        // Concrete evidence for the card: facts first, verdict second.
        var evidence: [String] = []
        if let hourly = opportunity.estimatedHourly {
            evidence.append(hourly >= profile.hourlyRateFloor
                ? "$\(Int(hourly))/hr — at or above your $\(Int(profile.hourlyRateFloor)) floor"
                : "$\(Int(hourly))/hr — below your $\(Int(profile.hourlyRateFloor)) floor")
        } else {
            evidence.append("Pay shown as “\(opportunity.payLabel)” — not yet confirmed")
        }
        evidence.append(opportunity.isRemote ? "Remote" : "In person · \(opportunity.locationLabel)")
        if !opportunity.requiredSkills.isEmpty {
            evidence.append("Asks for: \(opportunity.requiredSkills.joined(separator: ", "))")
        }

        return MatchResult(score: min(max(score, 0), 1), reasons: reasons, evidence: evidence)
    }

    public static func ranked(profile: EarningsProfile, opportunities: [Opportunity]) -> [(Opportunity, MatchResult)] {
        opportunities
            .map { ($0, evaluate(profile: profile, opportunity: $0)) }
            .sorted { $0.1.score > $1.1.score }
    }

    /// Below this confidence Hygge shows evidence but makes NO recommendation.
    public static let recommendationThreshold = 0.65
    /// Kept in a survey from here up; below the recommendation line it is
    /// borderline — kept visible, honestly labelled.
    public static let keepThreshold = 0.45

    public static func recommendation(for match: MatchResult) -> String? {
        guard match.confidence >= recommendationThreshold else { return nil }
        if let reason = match.reasons.first {
            return "This looks right for you — \(reason.lowercased()). I'd send it."
        }
        return "This looks right for you. I'd send it."
    }

    private static func dropReason(profile: EarningsProfile, opportunity: Opportunity) -> String {
        if let hourly = opportunity.estimatedHourly, hourly < profile.hourlyRateFloor * 0.8 {
            return "below your $\(Int(profile.hourlyRateFloor)) floor"
        }
        if !profile.interests.contains(opportunity.category) {
            return "not work you enjoy"
        }
        let mine = Set(profile.skills.map { $0.lowercased() })
        if !opportunity.requiredSkills.isEmpty,
           opportunity.requiredSkills.allSatisfy({ !mine.contains($0.lowercased()) }) {
            return "needs skills you haven't listed"
        }
        return "weak match"
    }

    /// One honest pass over listings actually read: kept, borderline, and
    /// dropped-with-reason — the negative space the journal reports from.
    public static func survey(profile: EarningsProfile, opportunities: [Opportunity], siteID: String) -> SearchEvidence {
        var kept: [String] = []
        var borderline: [String] = []
        var dropped: [SearchEvidence.Dropped] = []
        for opportunity in opportunities {
            // The floor is a promise, not a scoring factor: known pay below
            // it is dropped no matter how good everything else looks.
            if let hourly = opportunity.estimatedHourly, hourly < profile.hourlyRateFloor {
                dropped.append(.init(title: opportunity.title,
                                     reason: "below your $\(Int(profile.hourlyRateFloor)) floor"))
                continue
            }
            let match = evaluate(profile: profile, opportunity: opportunity)
            if match.score >= keepThreshold {
                kept.append(opportunity.title)
                if match.score < recommendationThreshold { borderline.append(opportunity.title) }
            } else {
                dropped.append(.init(title: opportunity.title,
                                     reason: dropReason(profile: profile, opportunity: opportunity)))
            }
        }
        return SearchEvidence(siteID: siteID, listingsRead: opportunities.count,
                              keptTitles: kept, borderlineTitles: borderline, dropped: dropped)
    }
}
