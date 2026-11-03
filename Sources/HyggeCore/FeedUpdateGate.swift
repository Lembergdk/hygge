import Foundation

public extension AgentTask {
    /// A browser waiting for a person's help is still an ongoing session.
    /// A stale session identifier on a terminal task never makes it live.
    var isActiveInFeed: Bool {
        status == .running || status == .approved || (status == .needsHuman && browserSessionID != nil)
    }
}

/// Controls presentation only. Live task data keeps updating even when new
/// cards are waiting for the reader to return to the top.
public struct FeedUpdateGate: Equatable {
    public private(set) var visibleIDs: [String] = []
    public private(set) var pendingIDs: [String] = []
    private var initialized = false

    public init() {}

    public mutating func receive(_ ids: [String], atTop: Bool) {
        var seen = Set<String>()
        let latest = ids.filter { seen.insert($0).inserted }
        if !initialized || atTop {
            visibleIDs = latest
            pendingIDs = []
            initialized = true
        } else {
            // Keep the order of cards already being read. Withdrawn items must
            // not remain actionable, and withdrawn pending items need no badge.
            let current = Set(latest)
            visibleIDs.removeAll { !current.contains($0) }
            let visible = Set(visibleIDs)
            pendingIDs = latest.filter { !visible.contains($0) }
        }
    }

    /// Undo is a deliberate local action, not permission to reveal every
    /// queued arrival. Restore only the requested card in its previous slot.
    public mutating func restore(_ id: String, at index: Int) {
        guard !visibleIDs.contains(id) else { return }
        visibleIDs.insert(id, at: min(max(0, index), visibleIDs.count))
        pendingIDs.removeAll { $0 == id }
    }
}
