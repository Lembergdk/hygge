import Foundation

/// A durable, task-scoped request in the conversation. No credentials belong here.
public struct TaskHelp: Codable, Equatable, Sendable, Identifiable {
    public enum Kind: String, Codable, Sendable { case information, verification, approval, credentials, recovery }
    public var id: UUID
    public var kind: Kind
    public var message: String
    public var questions: [Question]
    public var actionLabel: String
    /// Optional ISO-8601 expiry for a help, display only: the chat
    /// card shows "Expires <date>" when it parses. It never drives
    /// routing, escalation, or enforcement — every decision card
    /// reaches chat anyway — and there is no window and no "short"
    /// deadline concept. The agent sets it where an expiry applies;
    /// cases with no expiry leave it unset.
    public var deadline: String?
    public struct Question: Codable, Equatable, Sendable, Identifiable {
        public var id: String { text }
        public var text: String
        public var suggestions: [String]
        public init(text: String, suggestions: [String] = []) {
            self.text = text; self.suggestions = suggestions
        }
    }
    public init(id: UUID = UUID(), kind: Kind, message: String,
                questions: [Question] = [], actionLabel: String = "Continue", deadline: String? = nil) {
        self.id = id; self.kind = kind; self.message = message
        self.questions = questions; self.actionLabel = actionLabel; self.deadline = deadline
    }

    /// Whether the display-only expiry has passed. Derived lazily
    /// from the deadline timestamp — there is no server expired flag
    /// and no enforcement; this only drives the expired rendering.
    /// A help with no deadline, or one that does not parse, never
    /// expires. Whether the card is still pending is the caller's
    /// job: every render site only shows this for pending cards.
    public var isExpired: Bool {
        guard let deadline, let date = Self.expiryDate(deadline) else { return false }
        return date < Date()
    }

    /// A deadline is an ISO-8601 string; parse it leniently (with or
    /// without fractional seconds) and return nil when it does not
    /// parse — the deadline's validity is the server's job.
    public static func expiryDate(_ deadline: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        if let date = formatter.date(from: deadline) { return date }
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: deadline)
    }

}

public struct TaskReply: Codable, Equatable, Sendable {
    public var helpID: UUID
    public var answers: [String: String]
    public var approved: Bool
    public init(helpID: UUID, answers: [String: String] = [:], approved: Bool = false) {
        self.helpID = helpID; self.answers = answers; self.approved = approved
    }
}

extension AgentTask {
    public var isSiteSetup: Bool { kind == .signup || kind == .buildProfile }
    public var connectsExistingAccount: Bool { draftedPayload["setupMode"] == "connect" }
    public var needsChatHelp: Bool { status == .needsHuman || status == .failed }

    /// Whether a help request is something the user needs or can act on.
    /// A failed task whose only help is a recovery with nothing
    /// to review is not: the backend repairs that silently, and the help
    /// is still there when the user opens the chat for the task.
    public var helpIsActionable: Bool {
        let kind = help?.kind ?? (status == .failed ? .recovery : informationRequests.isEmpty ? .verification : .information)
        if kind == .recovery, status == .failed, pendingEffectID == nil { return false }
        return true
    }

    /// Clear the outstanding request only after the server accepted this choice.
    @discardableResult
    public mutating func stopHelp(helpID: UUID) -> Bool {
        guard needsChatHelp, help?.id == helpID else { return false }
        status = .rejected
        help = nil
        pendingReply = nil
        browserSessionID = nil
        informationRequests = []
        return true
    }

    /// Supplying information continues the original authorization. It never
    /// grants approval for a new public, permanent, or destructive action.
    public mutating func prepareReply(helpID: UUID, answers: [String: String] = [:], approved: Bool = false) -> Bool {
        guard status == .needsHuman || status == .failed,
              let help, help.id == helpID else { return false }
        if help.kind == .approval && !approved { return false }
        if help.kind == .information {
            guard !answers.isEmpty, answers.allSatisfy({ key, value in
                help.questions.contains(where: { $0.text == key }) && !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }) else { return false }
        }
        pendingReply = TaskReply(helpID: helpID, answers: answers, approved: approved)
        return true
    }
}
