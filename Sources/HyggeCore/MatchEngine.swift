import Foundation

public struct MatchResult: Equatable, Sendable {
    /// 0...1
    public var score: Double
    public var reasons: [String]
    public init(score: Double, reasons: [String]) {
        self.score = score
        self.reasons = reasons
    }
    public var percent: Int { Int((score * 100).rounded()) }
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

        return MatchResult(score: min(max(score, 0), 1), reasons: reasons)
    }

    public static func ranked(profile: EarningsProfile, opportunities: [Opportunity]) -> [(Opportunity, MatchResult)] {
        opportunities
            .map { ($0, evaluate(profile: profile, opportunity: $0)) }
            .sorted { $0.1.score > $1.1.score }
    }
}
