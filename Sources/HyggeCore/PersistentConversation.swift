import Foundation

public struct PersistentChatProposal: Decodable, Identifiable, Equatable, Sendable {
    public var id: String
    public var generation: String
    public var title: String
    public var operation: String
    public var status: String
    public var details: [String: String]?
    public var result: DeviceResult?
    public struct DeviceResult: Decodable, Equatable, Sendable {
        public var status: String?
        public var taskId: String?
        public var payload: [String: String]?
    }
}
public struct PersistentConversationState: Decodable, Sendable {
    public var conversationID: String
    public var generation: String
    public var proposals: [PersistentChatProposal]
    public var activeTurn: PendingTurn?
    public var reply: String?
    public var replyMessageId: UUID?
    public var cleanupPending: Int?
    public struct PendingTurn: Decodable, Sendable {
        public var id: String
        public var text: String
    }
}

public struct PersistentChatFocus: Codable, Sendable {
    public var kind: String
    public var id: String
    public init(kind: String, id: String) { self.kind = kind; self.id = id }
}
