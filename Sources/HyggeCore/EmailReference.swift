import Foundation

/// Resolves conversational references to filed mail — an explicit
/// sender or subject mention, or a short follow-up ("so check it",
/// "do something about it") after a mail was discussed. Pure and
/// deterministic: same inputs, same answer, and a negated or
/// unrelated message never resolves. The point is that the user
/// never has to recite an exact command phrase to be understood.
public enum EmailReferenceResolver {
    public struct Resolution: Equatable, Sendable {
        public var mail: FiledEmailSummary
        /// True for instructions ("check it", "do something"),
        /// false for reading questions ("what did it say?").
        public var wantsAction: Bool
        public init(mail: FiledEmailSummary, wantsAction: Bool) {
            self.mail = mail
            self.wantsAction = wantsAction
        }
    }

    private static let negations = ["don't", "do not", "never", "n't", "not yet"]
    private static let stopWords: Set<String> = [
        "your", "from", "with", "this", "that", "have", "been", "will",
        "message", "email", "mail", "jobs", "work", "update", "alert",
        "about", "their", "there", "which", "them", "then", "than",
    ]
    private static let followUpVerbs = [
        "check", "read", "open", "look", "do", "handle", "sort",
        "follow", "visit", "apply", "reply", "book",
    ]

    /// Cheap pre-filter (against whatever inbox is cached) deciding
    /// whether a message could plausibly be about mail — the inbox
    /// is only refreshed when this says yes.
    public static func mightConcernEmail(text: String, recentTranscript: [String],
                                         inbox: [FiledEmailSummary]) -> Bool {
        let lower = normalized(text)
        if lower.contains("email") || lower.contains("inbox") || lower.contains(" mail") {
            return true
        }
        if resolve(text: text, recentTranscript: recentTranscript, inbox: inbox) != nil {
            return true
        }
        // A fresh forward may not be in the cached inbox yet; a
        // follow-up imperative after mail talk still earns a refresh.
        if isFollowUp(lower) {
            let context = (recentTranscript.suffix(6).map(normalized) + [lower]).joined(separator: " ")
            if context.contains("forward") || context.contains("email") || context.contains(" mail") {
                return true
            }
        }
        return false
    }

    public static func resolve(text: String, recentTranscript: [String],
                               inbox: [FiledEmailSummary]) -> Resolution? {
        let lower = normalized(text)
        guard !lower.isEmpty, !inbox.isEmpty else { return nil }
        guard !negations.contains(where: { lower.contains($0) }) else { return nil }

        // Explicit: the message itself names the sender or subject.
        // A match by subject words alone only counts when the
        // message is actually asking or acting about mail, so
        // chatting about the same topic is never hijacked.
        if let match = bestMatch(haystack: lower, inbox: inbox),
           match.identity || hasAskSignal(lower) {
            return Resolution(mail: match.mail, wantsAction: wantsAction(lower))
        }
        // Contextual: a short follow-up whose meaning lives in the
        // recent conversation ("so check it", "do something about it").
        guard isFollowUp(lower) else { return nil }
        let context = recentTranscript.suffix(6).map(normalized).joined(separator: " ")
        guard let match = bestMatch(haystack: context, inbox: inbox) else { return nil }
        return Resolution(mail: match.mail, wantsAction: true)
    }

    /// Hosts a filed mail linked to, as filed summaries record them.
    public static func linkHosts(in mail: FiledEmailSummary) -> [String] {
        mail.actionableItems.compactMap { item -> String? in
            guard item.hasPrefix("Link to ") else { return nil }
            let host = String(item.dropFirst("Link to ".count))
                .trimmingCharacters(in: .whitespaces).lowercased()
            return host.isEmpty ? nil : host
        }
    }

    // MARK: - Matching

    private static func normalized(_ text: String) -> String {
        text.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func tokens(_ text: String) -> Set<String> {
        Set(text.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { $0.count >= 4 && !stopWords.contains($0) })
    }

    private static func mailTokens(_ mail: FiledEmailSummary) -> Set<String> {
        tokens("\(mail.subject) \(String(mail.summary.prefix(240)))")
    }

    /// A sender-domain (or its label, e.g. "rover") hit is identity.
    /// Subject words score by distinctiveness: a word only this one
    /// mail carries ("apartmentiq") identifies it; common words
    /// shared across the inbox barely count.
    private static func bestMatch(haystack: String, inbox: [FiledEmailSummary])
        -> (mail: FiledEmailSummary, identity: Bool)? {
        guard !haystack.isEmpty else { return nil }
        var frequency: [String: Int] = [:]
        for mail in inbox {
            for token in mailTokens(mail) { frequency[token, default: 0] += 1 }
        }
        let haystackTokens = tokens(haystack)
        var best: FiledEmailSummary?
        var bestScore = 0
        var bestIdentity = false
        for mail in inbox {
            var score = 0
            var identity = false
            let domain = mail.senderDomain.lowercased()
            if !domain.isEmpty, haystack.contains(domain) { score += 4; identity = true }
            let label = domain.split(separator: ".").first.map(String.init) ?? ""
            let genericLabels = ["mail", "email", "notifications", "noreply", "no-reply", "alert", "alerts", "news", "info"]
            if label.count >= 3, !genericLabels.contains(label), haystack.contains(label) { score += 3; identity = true }
            for token in mailTokens(mail).intersection(haystackTokens) {
                score += (frequency[token] ?? 0) <= 1 ? 3 : 1
            }
            if score >= 3, score > bestScore {
                best = mail
                bestScore = score
                bestIdentity = identity
            }
        }
        guard let best else { return nil }
        return (best, bestIdentity)
    }

    private static func hasAskSignal(_ lower: String) -> Bool {
        if lower.contains("?") { return true }
        let signals = ["what", "check", "read", "open", "look", "tell",
                       "say", "said", "about", "handle", "visit", "follow", "do "]
        return signals.contains(where: { lower.contains($0) })
    }

    private static func isFollowUp(_ lower: String) -> Bool {
        guard lower.count <= 60 else { return false }
        var probe = lower
        if probe.hasPrefix("so ") { probe = String(probe.dropFirst(3)) }
        if probe.hasPrefix("well ") { probe = String(probe.dropFirst(5)) }
        if probe.hasPrefix("please ") { probe = String(probe.dropFirst(7)) }
        let refersBack = [" it", " that", " this", " them", " one"]
            .contains(where: { probe.contains($0) }) || probe.hasSuffix(" it")
        let hasVerb = followUpVerbs.contains(where: { probe.hasPrefix($0) })
            || probe.contains("something about")
        return hasVerb && refersBack
    }

    private static func wantsAction(_ lower: String) -> Bool {
        let reading = ["what's in", "what is in", "what did", "what does",
                       "tell me", "summar", "who sent", "when did"]
        if reading.contains(where: { lower.contains($0) }) { return false }
        return true
    }
}
