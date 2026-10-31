import Foundation

/// Batching is allowed only for provably identical drafts. Identity is every
/// material (user-visible, outcome-affecting) payload field compared in
/// FULL — a shared 120-character prefix is not identity. Money/time-bearing
/// actions (calendar bookings), signups, and searches never batch: each is
/// its own decision.
public enum TaskBatching {
    public static let materialKeys = ["coverLetter", "profileBio", "profileHeadline",
                                      "hourlyRate", "skills", "searchTerms", "message"]

    public static func isBatchable(_ task: AgentTask) -> Bool {
        switch task.kind {
        case .apply, .message, .buildProfile:
            return materialFingerprint(task) != nil
        case .discover, .signup, .bookCalendar:
            return false
        }
    }

    /// Full material identity, or nil when the task has no material draft
    /// worth treating as a shared "same yes".
    public static func materialFingerprint(_ task: AgentTask) -> String? {
        var parts: [String] = []
        for key in materialKeys {
            if let value = task.draftedPayload[key] {
                parts.append("\(key)=\(value)")
            }
        }
        guard !parts.isEmpty else { return nil }
        return ([task.kind.rawValue, task.siteID] + parts).joined(separator: "\u{1}")
    }

    /// Groups preserving input order; non-batchable tasks are singletons.
    public static func groups(_ tasks: [AgentTask]) -> [[AgentTask]] {
        var order: [String] = []
        var grouped: [String: [AgentTask]] = [:]
        var resultSlots: [String] = []
        for task in tasks {
            if isBatchable(task), let key = materialFingerprint(task) {
                if grouped[key] == nil { order.append(key) }
                grouped[key, default: []].append(task)
            } else {
                let key = "single:\(task.id.uuidString)"
                order.append(key)
                grouped[key] = [task]
            }
            _ = resultSlots
        }
        return order.compactMap { grouped[$0] }
    }
}
