import Foundation

/// A structured thing the user asked Hygge to DO in conversation. Produced
/// by a strict command grammar (or, when the backend emits one, validated
/// model output) — never by loose substring matching on free prose. Actions
/// that change money, commitments, or site relationships require an inline
/// confirmation before they run.
public enum ChatAction: Codable, Equatable, Sendable {
    case pause
    case resume
    case stopSite(siteID: String)
    case changeFloor(Double)
    case approveFirst
    case bookFirst
    case explainDropped

    public var requiresConfirmation: Bool {
        switch self {
        case .stopSite, .changeFloor, .approveFirst, .bookFirst: return true
        case .pause, .resume, .explainDropped: return false
        }
    }
}

public enum ChatActionParser {
    /// Parse a user message as an explicit command. Returns nil for ordinary
    /// conversation — including sentences that merely mention action words
    /// or negate them ("Please don't pause Rover" parses to nothing).
    public static func parse(_ raw: String, sites: [TargetSite] = []) -> ChatAction? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = text.lowercased()
        guard !lower.isEmpty else { return nil }

        // Negated or qualified prose is conversation, not a command.
        let negations = ["don't", "do not", "never", "n't", "not yet", "no, "]
        let isNegated = negations.contains { lower.contains($0) }

        if lower.contains("what did you skip") || lower.contains("what did you drop")
            || lower.contains("why did you skip") || lower.contains("what did you pass on") {
            return .explainDropped
        }

        if !isNegated {
            if lower == "pause" || lower.hasPrefix("pause ") || lower.hasPrefix("pause,") {
                return .pause
            }
            if lower == "resume" || lower.hasPrefix("resume ") || lower == "unpause"
                || lower.hasPrefix("start again") {
                return .resume
            }
            if lower.hasPrefix("approve") {
                return .approveFirst
            }
            if lower.hasPrefix("book it") || lower == "book" {
                return .bookFirst
            }
            if lower.hasPrefix("stop watching") || lower.hasPrefix("stop ") {
                for site in sites where lower.contains(site.name.lowercased()) || lower.contains(site.domain) {
                    return .stopSite(siteID: site.id)
                }
                return nil
            }
            if let floor = parseFloor(lower) {
                return .changeFloor(floor)
            }
        }
        return nil
    }

    private static func parseFloor(_ lower: String) -> Double? {
        guard lower.contains("floor") || lower.contains("lowest rate") else { return nil }
        guard lower.contains("set") || lower.contains("change") || lower.contains(" to ") else { return nil }
        let digits = lower.components(separatedBy: CharacterSet.decimalDigits.inverted)
            .compactMap { Double($0) }
        return digits.first(where: { $0 > 0 && $0 < 1000 })
    }
}
