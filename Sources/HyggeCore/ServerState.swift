import Foundation

/// Brief 01 sync contract between the app cache and the per-user
/// server state (Durable Object tables via `/state/*` + entity routes).
///
/// The server is the source of truth; the local snapshot is a cache.
/// Conflict rule: newest `updatedAt` wins (last-write-wins on ties,
/// no merge UI). Demo opportunities are local-only: they are never
/// uploaded, and they are hidden once any real item exists.
/// Secrets never travel through state — only vault references do.

/// One server row: the model payload plus its sync metadata.
public struct StateRow<T: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
    public var id: String
    public var updatedAt: String
    public var data: T
    public init(id: String, updatedAt: String, data: T) {
        self.id = id
        self.updatedAt = updatedAt
        self.data = data
    }
}

public struct StateList<T: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
    public var items: [StateRow<T>]
    public init(items: [StateRow<T>]) { self.items = items }
}

/// The profile singleton payload: the earnings profile plus the small
/// app-level facts that must follow the user across devices.
public struct ProfileState: Codable, Equatable, Sendable {
    public var profile: EarningsProfile
    public var hasOnboarded: Bool
    public var isPaused: Bool
    public var lastVisitAt: Date?
    public init(profile: EarningsProfile, hasOnboarded: Bool, isPaused: Bool, lastVisitAt: Date?) {
        self.profile = profile
        self.hasOnboarded = hasOnboarded
        self.isPaused = isPaused
        self.lastVisitAt = lastVisitAt
    }
}

/// One account-state row as stored server-side (siteID is the row id).
public struct AccountStateRow: Codable, Equatable, Sendable {
    public var siteID: String
    public var state: SiteAccountState
    public init(siteID: String, state: SiteAccountState) {
        self.siteID = siteID
        self.state = state
    }
}

/// A belief row: the belief plus whether it is still awaiting the
/// user's confirmation. Semantics stay with Brief 06; this is storage.
public struct BeliefRow: Codable, Equatable, Sendable {
    public var id: UUID
    public var sentence: String
    public var source: Belief.Source
    public var learnedAt: Date
    public var confidence: Double
    public var pending: Bool
    public init(belief: Belief, pending: Bool) {
        id = belief.id
        sentence = belief.sentence
        source = belief.source
        learnedAt = belief.learnedAt
        confidence = belief.confidence
        self.pending = pending
    }
    public var belief: Belief {
        Belief(id: id, sentence: sentence, source: source, learnedAt: learnedAt, confidence: confidence)
    }
}

/// Full `GET /state/export` response: everything a fresh install
/// needs to show the same feed, messages, and profile.
public struct ServerExport: Codable, Equatable, Sendable {
    public var profile: StateRow<ProfileState>?
    public var feedItems: [StateRow<Opportunity>]
    public var messages: [StateRow<ChatEntry>]
    public var sites: [StateRow<TargetSite>]
    public var opportunities: [StateRow<Opportunity>]
    public var applications: [StateRow<ApplicationRecord>]
    public var proposals: [StateRow<ProposedSite>]
    public var accountStates: [String: SiteAccountState]
    public var journalEvents: [StateRow<ActivityEvent>]
    public var beliefs: BeliefBook
    public var beliefRows: [StateRow<BeliefRow>]
    public var searchEvidence: [StateRow<SearchEvidence>]
    public var counts: [String: Int]
    public var hasRealFeedItem: Bool

    public init(profile: StateRow<ProfileState>? = nil, feedItems: [StateRow<Opportunity>] = [],
                messages: [StateRow<ChatEntry>] = [], sites: [StateRow<TargetSite>] = [],
                opportunities: [StateRow<Opportunity>] = [], applications: [StateRow<ApplicationRecord>] = [],
                proposals: [StateRow<ProposedSite>] = [], accountStates: [String: SiteAccountState] = [:],
                journalEvents: [StateRow<ActivityEvent>] = [], beliefs: BeliefBook = BeliefBook(),
                beliefRows: [StateRow<BeliefRow>] = [], searchEvidence: [StateRow<SearchEvidence>] = [],
                counts: [String: Int] = [:], hasRealFeedItem: Bool = false) {
        self.profile = profile
        self.feedItems = feedItems
        self.messages = messages
        self.sites = sites
        self.opportunities = opportunities
        self.applications = applications
        self.proposals = proposals
        self.accountStates = accountStates
        self.journalEvents = journalEvents
        self.beliefs = beliefs
        self.beliefRows = beliefRows
        self.searchEvidence = searchEvidence
        self.counts = counts
        self.hasRealFeedItem = hasRealFeedItem
    }

    /// Tolerant decode: a missing section means "none yet", never a wipe.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        profile = try c.decodeIfPresent(StateRow<ProfileState>.self, forKey: .profile)
        feedItems = try c.decodeIfPresent([StateRow<Opportunity>].self, forKey: .feedItems) ?? []
        messages = try c.decodeIfPresent([StateRow<ChatEntry>].self, forKey: .messages) ?? []
        sites = try c.decodeIfPresent([StateRow<TargetSite>].self, forKey: .sites) ?? []
        opportunities = try c.decodeIfPresent([StateRow<Opportunity>].self, forKey: .opportunities) ?? []
        applications = try c.decodeIfPresent([StateRow<ApplicationRecord>].self, forKey: .applications) ?? []
        proposals = try c.decodeIfPresent([StateRow<ProposedSite>].self, forKey: .proposals) ?? []
        accountStates = try c.decodeIfPresent([String: SiteAccountState].self, forKey: .accountStates) ?? [:]
        journalEvents = try c.decodeIfPresent([StateRow<ActivityEvent>].self, forKey: .journalEvents) ?? []
        beliefs = try c.decodeIfPresent(BeliefBook.self, forKey: .beliefs) ?? BeliefBook()
        beliefRows = try c.decodeIfPresent([StateRow<BeliefRow>].self, forKey: .beliefRows) ?? []
        searchEvidence = try c.decodeIfPresent([StateRow<SearchEvidence>].self, forKey: .searchEvidence) ?? []
        counts = try c.decodeIfPresent([String: Int].self, forKey: .counts) ?? [:]
        hasRealFeedItem = try c.decodeIfPresent(Bool.self, forKey: .hasRealFeedItem) ?? false
    }
}

/// `POST /state/import` body: the local snapshot, demo items excluded.
/// Credential refs are sent for accounting only; the server counts and
/// ignores them because the vault is already authoritative. No secret
/// field exists on this type by construction.
public struct ServerImport: Codable, Equatable, Sendable {
    public var profile: EarningsProfile
    public var hasOnboarded: Bool
    public var isPaused: Bool
    public var lastVisitAt: Date?
    public var sites: [TargetSite]
    public var siteMemory: SiteMemoryRepository
    public var credentialRefs: [CredentialRef]
    public var opportunities: [Opportunity]
    public var tasks: [AgentTask]
    public var applications: [ApplicationRecord]
    public var proposals: [ProposedSite]
    public var accountStates: [String: SiteAccountState]
    public var chatTranscript: [ChatEntry]
    public var activityEvents: [ActivityEvent]
    public var beliefs: BeliefBook
    public var searchEvidence: [SearchEvidence]

    public init(profile: EarningsProfile, hasOnboarded: Bool, isPaused: Bool, lastVisitAt: Date?,
                sites: [TargetSite], siteMemory: SiteMemoryRepository, credentialRefs: [CredentialRef],
                opportunities: [Opportunity], tasks: [AgentTask], applications: [ApplicationRecord],
                proposals: [ProposedSite], accountStates: [String: SiteAccountState],
                chatTranscript: [ChatEntry], activityEvents: [ActivityEvent],
                beliefs: BeliefBook, searchEvidence: [SearchEvidence]) {
        self.profile = profile
        self.hasOnboarded = hasOnboarded
        self.isPaused = isPaused
        self.lastVisitAt = lastVisitAt
        self.sites = sites
        self.siteMemory = siteMemory
        self.credentialRefs = credentialRefs
        // Demo items are local-only and never become server state.
        self.opportunities = opportunities.filter { !$0.isDemo }
        self.tasks = tasks
        self.applications = applications
        self.proposals = proposals
        self.accountStates = accountStates
        self.chatTranscript = chatTranscript
        self.activityEvents = activityEvents
        self.beliefs = beliefs
        self.searchEvidence = searchEvidence
    }
}

public struct ImportResult: Codable, Equatable, Sendable {
    public var ok: Bool
    public var counts: [String: Int]
    public var hasRealFeedItem: Bool
    public var skippedDemo: Int
    public var credentialRefsSkipped: Int
    public init(ok: Bool, counts: [String: Int], hasRealFeedItem: Bool, skippedDemo: Int, credentialRefsSkipped: Int) {
        self.ok = ok
        self.counts = counts
        self.hasRealFeedItem = hasRealFeedItem
        self.skippedDemo = skippedDemo
        self.credentialRefsSkipped = credentialRefsSkipped
    }
}

public struct StateCounts: Codable, Equatable, Sendable {
    public var counts: [String: Int]
    public var hasRealFeedItem: Bool
    public init(counts: [String: Int], hasRealFeedItem: Bool) {
        self.counts = counts
        self.hasRealFeedItem = hasRealFeedItem
    }
    public var total: Int { counts.values.reduce(0, +) }
}

/// Audit mapping for the acceptance check "no snapshot type remains
/// solely on-device" (Brief 01). Every StoreSnapshot field must appear.
public struct SnapshotFieldMapping: Equatable, Sendable {
    public var snapshotField: String
    public var endpoint: String
    public var table: String
    public init(_ snapshotField: String, _ endpoint: String, _ table: String) {
        self.snapshotField = snapshotField
        self.endpoint = endpoint
        self.table = table
    }
}

public enum StateSync {
    public static let snapshotMapping: [SnapshotFieldMapping] = [
        .init("profile", "GET/PUT /profile (in /state/export)", "profile"),
        .init("hasOnboarded", "profile singleton payload", "profile"),
        .init("isPaused", "profile singleton payload", "profile"),
        .init("lastVisitAt", "profile singleton payload", "profile"),
        .init("sites", "GET/POST/PUT /sites", "sites"),
        .init("siteMemory", "GET /memory (existing)", "memories"),
        .init("credentialRefs", "GET /credentials (existing vault metadata)", "credentials"),
        .init("opportunities", "GET/POST/PUT /opportunities + /feed-items", "opportunities/feed_items"),
        .init("tasks", "GET/POST /tasks (existing; import preserves by id)", "tasks"),
        .init("applications", "GET/POST/PUT /applications", "applications"),
        .init("proposals", "GET/POST/PUT /proposals", "proposals"),
        .init("accountStates", "GET/POST/PUT /account-states", "account_states"),
        .init("chatTranscript", "GET/POST/PUT /messages", "messages"),
        .init("activityEvents", "GET/POST/PUT /journal-events", "journal_events"),
        .init("beliefs", "GET/POST/PUT /beliefs", "beliefs"),
        .init("searchEvidence", "GET/POST/PUT /search-evidence", "search_evidence"),
    ]

    /// All StoreSnapshot field names, for the completeness test.
    public static let snapshotFields = [
        "profile", "hasOnboarded", "sites", "siteMemory", "credentialRefs",
        "opportunities", "tasks", "applications", "proposals", "accountStates",
        "chatTranscript", "activityEvents", "isPaused", "lastVisitAt",
        "beliefs", "searchEvidence",
    ]

    public static var unmappedSnapshotFields: [String] {
        let mapped = Set(snapshotMapping.map(\.snapshotField))
        return snapshotFields.filter { !mapped.contains($0) }
    }

    /// Newest `updatedAt` (ISO-8601, compared lexicographically) wins.
    public static func shouldApply(existingUpdatedAt: String?, incomingUpdatedAt: String) -> Bool {
        guard let existingUpdatedAt else { return true }
        return incomingUpdatedAt >= existingUpdatedAt
    }

    public static func hasRealFeedItem(_ opportunities: [Opportunity]) -> Bool {
        opportunities.contains { !$0.isDemo }
    }

    /// What the feed may show: demo items disappear as soon as a real
    /// item exists locally or on the server for this user.
    public static func visibleOpportunities(_ all: [Opportunity], serverHasReal: Bool) -> [Opportunity] {
        guard serverHasReal || hasRealFeedItem(all) else { return all }
        return all.filter { !$0.isDemo }
    }

    /// What may be uploaded: never demo items.
    public static func uploadableOpportunities(_ all: [Opportunity]) -> [Opportunity] {
        all.filter { !$0.isDemo }
    }

    /// Union by id; on conflict the newest timestamp wins. A nil
    /// timestamp loses to any dated row; undated local-only rows
    /// (e.g. demo items) survive only through `visibleOpportunities`.
    public static func mergeByID<T>(local: [(value: T, updatedAt: String?)],
                                    server: [(value: T, updatedAt: String?)],
                                    id: (T) -> String) -> [T] {
        var winners: [String: (value: T, updatedAt: String?)] = [:]
        var order: [String] = []
        func consider(_ candidate: (value: T, updatedAt: String?)) {
            let key = id(candidate.value).lowercased()
            if let existing = winners[key] {
                let existingStamp = existing.updatedAt ?? ""
                let candidateStamp = candidate.updatedAt ?? ""
                if candidateStamp >= existingStamp { winners[key] = candidate }
            } else {
                winners[key] = candidate
                order.append(key)
            }
        }
        server.forEach(consider)
        local.forEach(consider)
        return order.compactMap { winners[$0]?.value }
    }

    /// Row counts the server should report after importing `payload`,
    /// keyed like the server's counts. Used to verify the migration
    /// before flipping to backend-first.
    public static func expectedImportCounts(_ payload: ServerImport) -> [String: Int] {
        [
            "profile": 1,
            "sites": Set(payload.sites.map { $0.id.lowercased() }).count,
            "opportunities": Set(payload.opportunities.map { $0.id.uuidString.lowercased() }).count,
            "feedItems": Set(payload.opportunities.map { $0.id.uuidString.lowercased() }).count,
            "messages": Set(payload.chatTranscript.map { $0.id.uuidString.lowercased() }).count,
            "applications": Set(payload.applications.map { $0.id.uuidString.lowercased() }).count,
            "proposals": Set(payload.proposals.map { $0.id.uuidString.lowercased() }).count,
            "accountStates": payload.accountStates.count,
            "journalEvents": Set(payload.activityEvents.map { $0.id.uuidString.lowercased() }).count,
            "beliefs": Set((payload.beliefs.beliefs + payload.beliefs.pending).map { $0.id.uuidString.lowercased() }).count,
            "searchEvidence": Set(payload.searchEvidence.map { $0.id.uuidString.lowercased() }).count,
        ]
    }

    /// Empty result means the import verified. Server counts may be
    /// higher than expected (another device wrote first) — that is not
    /// a mismatch; only missing rows fail verification.
    public static func importMismatches(expected: [String: Int], serverCounts: [String: Int]) -> [String] {
        expected.compactMap { key, want in
            (serverCounts[key] ?? 0) < want ? "\(key): expected at least \(want), found \(serverCounts[key] ?? 0)" : nil
        }.sorted()
    }
}

/// What a write may claim when the backend cannot be reached. Under
/// the Release `HYGGE_REQUIRE_CLOUD` stance an offline write fails
/// honestly: it may touch the cache, but it must never report itself
/// as saved. There is no queue-and-pretend outcome.
public enum OfflineWriteOutcome: Equatable, Sendable {
    case savedToServer
    case failedUnreachable
    case cacheOnlyDebugBuild

    public var claimsSaved: Bool { self == .savedToServer }
}

public enum OfflineWritePolicy {
    public static func outcome(reachable: Bool, requireCloud: Bool) -> OfflineWriteOutcome {
        if reachable { return .savedToServer }
        return requireCloud ? .failedUnreachable : .cacheOnlyDebugBuild
    }
}
