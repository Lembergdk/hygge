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
    /// Look for work on a site the user already approved (read-only search).
    case scanSite(siteID: String)
    /// Join (or re-join) a known site: consent was the sentence itself.
    case joinSite(siteID: String)
    /// Add a brand-new site by its address, then join it.
    case addSite(domain: String)
    /// Report what is in the user's Hygge inbox.
    case checkEmail

    public var requiresConfirmation: Bool {
        switch self {
        case .stopSite, .changeFloor, .approveFirst, .bookFirst: return true
        case .pause, .resume, .explainDropped, .scanSite, .joinSite, .addSite, .checkEmail: return false
        }
    }
}

public enum ChatActionParser {
    /// Parse a user message as an explicit command. Returns nil for ordinary
    /// conversation — including sentences that merely mention action words
    /// or negate them ("Please don't pause Rover" parses to nothing).
    public static func parse(_ raw: String, sites: [TargetSite] = []) -> ChatAction? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        var lower = text.lowercased()
        guard !lower.isEmpty else { return nil }
        // A leading "please" is politeness, not part of the command.
        if lower.hasPrefix("please ") { lower = String(lower.dropFirst("please ".count)) }

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
            // Work-starting commands. These execute in the app, never in
            // the conversation model — a prose reply must not be able to
            // claim work started when nothing did.
            let joinVerbs = ["re-add", "readd", "add back", "bring back", "start watching", "watch ", "join ", "track ", "add "]
            if joinVerbs.contains(where: { lower.hasPrefix($0) || lower == $0.trimmingCharacters(in: .whitespaces) }) {
                if let site = matchedSite(in: lower, sites: sites) {
                    return .joinSite(siteID: site.id)
                }
                if let domain = parseDomain(lower) {
                    return .addSite(domain: domain)
                }
                // "add …" with neither a known site nor an address is
                // conversation; the app never guesses a destination.
                return nil
            }
            let scanVerbs = ["scan ", "search ", "check ", "look on ", "look at ", "look for work on ", "find work on ", "find jobs on "]
            if scanVerbs.contains(where: { lower.hasPrefix($0) }),
               let site = matchedSite(in: lower, sites: sites) {
                return .scanSite(siteID: site.id)
            }
            if isEmailCheck(lower) {
                return .checkEmail
            }
        }
        return nil
    }

    private static func matchedSite(in lower: String, sites: [TargetSite]) -> TargetSite? {
        sites.first { lower.contains($0.name.lowercased()) || lower.contains($0.domain) }
    }

    /// The first site-address-shaped token ("pawshake.com",
    /// "https://www.pawshake.com/jobs"), normalized to its host.
    private static func parseDomain(_ lower: String) -> String? {
        for rawToken in lower.split(separator: " ") {
            var token = rawToken.trimmingCharacters(in: CharacterSet(charactersIn: ":,.<>()[]"))
            token = token.replacingOccurrences(of: "https://", with: "")
                .replacingOccurrences(of: "http://", with: "")
            let host = token.split(separator: "/").first.map(String.init) ?? token
            let bare = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
            guard !bare.contains("@"), bare.contains(".") else { continue }
            let labels = bare.split(separator: ".")
            guard labels.count >= 2, labels.allSatisfy({ !$0.isEmpty }),
                  let tld = labels.last, tld.count >= 2, tld.allSatisfy(\.isLetter) else { continue }
            return bare
        }
        return nil
    }

    private static func isEmailCheck(_ lower: String) -> Bool {
        let mentionsInbox = lower.contains("email") || lower.contains("inbox")
            || lower.contains("your mail") || lower.contains("my mail")
        guard mentionsInbox else { return false }
        let openers = ["check ", "look ", "read ", "did you get", "did my", "have you seen", "any new"]
        return openers.contains { lower.hasPrefix($0) }
    }

    private static func parseFloor(_ lower: String) -> Double? {
        guard lower.contains("floor") || lower.contains("lowest rate") else { return nil }
        guard lower.contains("set") || lower.contains("change") || lower.contains(" to ") else { return nil }
        let digits = lower.components(separatedBy: CharacterSet.decimalDigits.inverted)
            .compactMap { Double($0) }
        return digits.first(where: { $0 > 0 && $0 < 1000 })
    }
}
