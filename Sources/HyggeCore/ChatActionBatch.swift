import Foundation

/// Preserve model order and stop at each confirmation boundary. An unavailable
/// item is an outcome too; it must not disappear behind another item's success.
public enum ChatBatchItem: Equatable, Sendable {
    case action(ChatAction)
    case unavailable(String)
}

public enum ChatActionBatch {
    public struct Progress: Equatable, Sendable {
        public var replies: [String]
        public var confirmation: ChatAction?
        public var remaining: [ChatBatchItem]
    }

    @MainActor
    public static func run(_ items: [ChatBatchItem],
                           execute: (ChatAction) async -> String) async -> Progress {
        var replies: [String] = []
        for (index, item) in items.enumerated() {
            switch item {
            case .unavailable(let reason): replies.append(reason)
            case .action(let action):
                if action.requiresConfirmation {
                    return Progress(replies: replies, confirmation: action,
                                    remaining: Array(items.dropFirst(index + 1)))
                }
                replies.append(await execute(action))
            }
        }
        return Progress(replies: replies, confirmation: nil, remaining: [])
    }
}
