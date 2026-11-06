import CryptoKit
import Foundation

/// A durable, task-scoped request in the conversation. No credentials belong here.
public struct TaskHelp: Codable, Equatable, Sendable, Identifiable {
    public enum Kind: String, Codable, Sendable { case information, verification, approval, credentials, recovery }
    public var id: UUID
    public var kind: Kind
    public var message: String
    public var questions: [Question]
    public var actionLabel: String
    /// Optional ISO-8601 deadline for an approval: a deadline-free
    /// approval surfaces in the feed only; one with a deadline also
    /// reaches chat (with a push). No producer sets this yet — it is
    /// the extension point for short-deadline approvals.
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

    /// A stable id for a synthesized help request, derived from the help's
    /// content: the same situation re-synthesizes the same id across polls
    /// (so the transcript guard dedupes it and a review tap never goes
    /// stale), while a changed situation mints a different id.
    public static func stableSynthesizedID(taskID: UUID, status: String, pendingEffectID: String?, informationRequests: [String]) -> UUID {
        let input = [taskID.uuidString, status, pendingEffectID ?? "", informationRequests.joined(separator: "\n")].joined(separator: "\u{1F}")
        var bytes = Array(SHA256.hash(data: Data(input.utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0F) | 0x50
        bytes[8] = (bytes[8] & 0x3F) | 0x80
        return bytes.withUnsafeBytes { UUID(uuid: $0.load(as: uuid_t.self)) }
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
