import Foundation

/// A site the cloud browser should work on. Users can add any URL —
/// the agent needs no per-site API or integration.
public struct TargetSite: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var startURLString: String
    public var category: OpportunityCategory
    public var goalTemplate: String

    public init(id: String, name: String, startURLString: String,
                category: OpportunityCategory, goalTemplate: String) {
        self.id = id
        self.name = name
        self.startURLString = startURLString
        self.category = category
        self.goalTemplate = goalTemplate
    }

    public var domain: String {
        URL(string: startURLString)?.host?.replacingOccurrences(of: "www.", with: "") ?? id
    }

    public static func userAdded(name: String, urlOrDomain: String,
                                 category: OpportunityCategory) -> TargetSite? {
        var raw = urlOrDomain.trimmingCharacters(in: .whitespaces)
        guard !raw.isEmpty else { return nil }
        if !raw.contains("://") { raw = "https://" + raw }
        guard let url = URL(string: raw), let host = url.host, host.contains(".") else { return nil }
        let domain = host.replacingOccurrences(of: "www.", with: "")
        return TargetSite(
            id: domain, name: name.isEmpty ? domain : name, startURLString: raw,
            category: category,
            goalTemplate: "Find current opportunities on this site that match my earnings profile and extract their title, pay, location and link.")
    }
}

public enum MemoryKind: String, Codable, CaseIterable, Sendable {
    case login, signup, buildProfile, searchOpportunities, apply, message, bookCalendar
    public var label: String {
        switch self {
        case .login: return "Log in"
        case .signup: return "Sign up"
        case .buildProfile: return "Build profile"
        case .searchOpportunities: return "Search opportunities"
        case .apply: return "Apply"
        case .message: return "Send message"
        case .bookCalendar: return "Book / schedule"
        }
    }
}

public enum BrowserActionKind: String, Codable, Sendable {
    case navigate, click, type, select, extract, screenshot, waitForHuman, askUser, done, needsHuman
}

public struct BrowserTraceEvent: Codable, Equatable, Sendable {
    public var action: BrowserActionKind
    public var target: String
    public var urlString: String
    public var summary: String
    public var succeeded: Bool
    public init(action: BrowserActionKind, target: String, urlString: String,
                summary: String, succeeded: Bool) {
        self.action = action
        self.target = target
        self.urlString = urlString
        self.summary = summary
        self.succeeded = succeeded
    }
}

/// What the agent remembers about using one domain for one kind of mission:
/// advisory HINTS distilled from past trajectories. Deliberately NOT steps —
/// every mission starts from its goal and the live page; hints are context
/// the agent may use or ignore when the page disagrees.
public struct SiteMemory: Codable, Identifiable, Equatable, Sendable {
    public var id: UUID
    public var domain: String
    public var kind: MemoryKind
    public var hints: [String]
    public var successCount: Int
    public var failureCount: Int
    public var updatedAt: Date

    public init(id: UUID = UUID(), domain: String, kind: MemoryKind, hints: [String] = [],
                successCount: Int = 0, failureCount: Int = 0, updatedAt: Date = Date()) {
        self.id = id
        self.domain = domain
        self.kind = kind
        self.hints = hints
        self.successCount = successCount
        self.failureCount = failureCount
        self.updatedAt = updatedAt
    }

    public var attempts: Int { successCount + failureCount }
    public var confidence: Double { Double(successCount + 1) / Double(attempts + 2) }
}

public struct SiteMemoryRepository: Codable, Equatable, Sendable {
    public var memories: [SiteMemory]
    public init(memories: [SiteMemory] = []) { self.memories = memories }

    public func memory(domain: String, kind: MemoryKind) -> SiteMemory? {
        memories.first { $0.domain == domain && $0.kind == kind }
    }

    public func hints(domain: String, kind: MemoryKind) -> [String] {
        memory(domain: domain, kind: kind)?.hints ?? []
    }

    public mutating func recordOutcome(memoryID: UUID, success: Bool) {
        guard let index = memories.firstIndex(where: { $0.id == memoryID }) else { return }
        if success { memories[index].successCount += 1 } else { memories[index].failureCount += 1 }
        memories[index].updatedAt = Date()
    }

    /// Distil a successful trajectory into advisory hints. Creates the memory
    /// on first success; learning is an output of browsing, never a script.
    @discardableResult
    public mutating func learn(domain: String, kind: MemoryKind, trace: [BrowserTraceEvent],
                               extractedCount: Int = 0) -> SiteMemory? {
        var newHints: [String] = []
        for event in trace {
            if event.succeeded && event.action == .click {
                newHints.append("Clicking \"\(event.target)\" worked on \(domain)")
            } else if event.succeeded && event.action == .type && !event.target.lowercased().contains("password") {
                newHints.append("Typing into \"\(event.target)\" worked on \(domain)")
            } else if !event.succeeded && event.action != .needsHuman {
                newHints.append("\"\(event.target)\" was NOT found on \(domain) — look for a different label/element")
            }
        }
        if extractedCount > 0 { newHints.append("Listings were readable directly from the landing page on \(domain)") }
        if trace.contains(where: { $0.summary.lowercased().contains("vault") }) {
            newHints.append("Vault credential login worked on \(domain)")
        }
        guard !newHints.isEmpty else { return memory(domain: domain, kind: kind) }
        if let index = memories.firstIndex(where: { $0.domain == domain && $0.kind == kind }) {
            for hint in newHints where !memories[index].hints.contains(hint) {
                memories[index].hints.append(hint)
            }
            memories[index].hints = Array(memories[index].hints.suffix(12))
            memories[index].successCount += 1
            memories[index].updatedAt = Date()
            return memories[index]
        }
        let memory = SiteMemory(domain: domain, kind: kind, hints: Array(newHints.suffix(12)), successCount: 1)
        memories.append(memory)
        return memory
    }
}

/// Whether a site lets a saved "trust this device" sign-in be reused.
/// Unknown means "try and learn", never "assume".
public enum TrustSupport: String, Codable, Sendable {
    case supported, unsupported, unknown
}

/// Metadata about a saved trusted sign-in for one site. By construction
/// this cannot carry the sign-in itself (cookies stay sealed on the
/// helper) — only whether one exists and what has been learned.
/// Deleting this never deletes the saved login, and vice versa.
public struct SessionProfileRef: Codable, Identifiable, Equatable, Sendable {
    public var id: String { domain }
    public var domain: String
    public var trustSupport: TrustSupport
    public var hasProfile: Bool
    public init(domain: String, trustSupport: TrustSupport = .unknown, hasProfile: Bool) {
        self.domain = domain
        self.trustSupport = trustSupport
        self.hasProfile = hasProfile
    }
}

/// Reference to a credential in the server-side vault. By construction this
/// type cannot carry the secret: the app holds only domain + username + id.
public struct CredentialRef: Codable, Identifiable, Equatable, Sendable {
    public var id: UUID
    public var domain: String
    public var username: String
    public var createdAt: Date
    public init(id: UUID = UUID(), domain: String, username: String, createdAt: Date = Date()) {
        self.id = id
        self.domain = domain
        self.username = username
        self.createdAt = createdAt
    }
}

public struct PageElement: Codable, Equatable, Sendable, Identifiable {
    public var id: String { label }
    public var label: String
    public var kind: BrowserActionKind
    public init(label: String, kind: BrowserActionKind) { self.label = label; self.kind = kind }
}

/// What the iOS cloud-browser view renders for watching / takeover.
public struct BrowserSessionSnapshot: Codable, Equatable, Sendable {
    public var sessionID: String
    public var currentURLString: String
    public var title: String
    public var elements: [PageElement]
    public var humanControlled: Bool
    public var screenshotBase64: String?
    public init(sessionID: String, currentURLString: String, title: String,
                elements: [PageElement], humanControlled: Bool, screenshotBase64: String? = nil) {
        self.sessionID = sessionID
        self.currentURLString = currentURLString
        self.title = title
        self.elements = elements
        self.humanControlled = humanControlled
        self.screenshotBase64 = screenshotBase64
    }
}
