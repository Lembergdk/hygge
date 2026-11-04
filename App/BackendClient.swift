import Foundation

/// A sign-in failure in words the user can act on.
enum AuthClientError: LocalizedError {
    case message(String)
    case unavailable
    case reauthenticationRequired

    var errorDescription: String? {
        switch self {
        case .message(let message): return message
        case .reauthenticationRequired: return "Confirm it’s you with an email link, then try again."
        case .unavailable: return "Sign-in is unavailable just now. Try again in a moment."
        }
    }
}

/// Talks to the Hygge agent service (backend/agent-service). The service
/// owns the cloud browser, the skills repository, and the credential vault.
/// Every call is optional from the app's perspective: when unreachable, the
/// store falls back to the local simulated runner and says so in the log.
struct BackendClient {
    /// Whether this build must reach the cloud (HYGGE_REQUIRE_CLOUD:
    /// NO in Debug, YES in Release). When true, an unreachable backend
    /// fails the task honestly instead of simulating it on-device.
    static var requireCloud: Bool {
        let raw = Bundle.main.object(forInfoDictionaryKey: "HYGGE_REQUIRE_CLOUD")
        let value = (raw as? String) ?? (raw as? Bool).map { $0 ? "YES" : "NO" }
        #if DEBUG
        return CloudRequirement.resolve(infoPlistValue: value, isDebugBuild: true)
        #else
        return CloudRequirement.resolve(infoPlistValue: value, isDebugBuild: false)
        #endif
    }

    /// Default backend per build: staging for Debug, production for
    /// Release. A user override (developer settings) still wins.
    static var defaultBaseURLString: String {
        #if DEBUG
        return "https://api-staging.usehygge.app"
        #else
        return "https://api.usehygge.app"
        #endif
    }

    var baseURL: URL {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--settings-preview") {
            return URL(string: ProcessInfo.processInfo.arguments.contains("--browser-preview") ? "http://127.0.0.1:8768" : "http://127.0.0.1:9")!
        }
        #endif
        let raw = BackendAddress.effective(
            stored: UserDefaults.standard.string(forKey: "backendBaseURL"),
            fallback: Self.defaultBaseURLString)
        return URL(string: raw) ?? URL(string: Self.defaultBaseURLString)!
    }

    /// The session token, from the Keychain only (Brief 00). A token
    /// left in UserDefaults by an older build is migrated once (or
    /// dropped when paired with a retired local-backend URL), then
    /// removed from UserDefaults. Debug may still fall back to a
    /// baked staging token; Release requires a real session.
    var apiToken: String {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--settings-preview") { return "" }
        #endif
        if let token = KeychainTokenStore.read() { return token }
        let legacy = UserDefaults.standard.string(forKey: SessionTokenStorage.legacyUserDefaultsKey)
        let storedURL = UserDefaults.standard.string(forKey: "backendBaseURL")
        if SessionTokenStorage.shouldMigrateLegacyToken(storedToken: legacy, storedBaseURL: storedURL),
           let legacy {
            _ = KeychainTokenStore.write(legacy)
            UserDefaults.standard.removeObject(forKey: SessionTokenStorage.legacyUserDefaultsKey)
            return legacy
        }
        if legacy != nil {
            UserDefaults.standard.removeObject(forKey: SessionTokenStorage.legacyUserDefaultsKey)
        }
        #if DEBUG
        // Personal dev builds can bake a staging token in at build time
        // (xcodebuild HYGGE_STAGING_TOKEN=…); never set in CI or Release.
        return Bundle.main.object(forInfoDictionaryKey: "HYGGE_STAGING_TOKEN") as? String ?? ""
        #else
        return ""
        #endif
    }

    var hasSessionToken: Bool { !apiToken.isEmpty }

    /// Which account the current session belongs to, and which one
    /// it replaced. Opaque ids only (never the token), so sign-in
    /// can tell a same-account return from a different account
    /// arriving on a device that still caches the previous one.
    private static let sessionUserIDKey = "auth.sessionUserID"
    private static let previousSessionUserIDKey = "auth.previousSessionUserID"
    var sessionUserID: String? { UserDefaults.standard.string(forKey: Self.sessionUserIDKey) }
    var previousSessionUserID: String? { UserDefaults.standard.string(forKey: Self.previousSessionUserIDKey) }

    // Server identity, independent of the local profile/onboarding cache.
    var sessionIsNewUser: Bool { UserDefaults.standard.bool(forKey: "auth.sessionIsNewUser") }

    func setSessionToken(_ token: String, userID: String? = nil) {
        if let userID {
            if let current = sessionUserID {
                UserDefaults.standard.set(current, forKey: Self.previousSessionUserIDKey)
            } else {
                UserDefaults.standard.removeObject(forKey: Self.previousSessionUserIDKey)
            }
            UserDefaults.standard.set(userID, forKey: Self.sessionUserIDKey)
        }
        _ = KeychainTokenStore.write(token)
        UserDefaults.standard.removeObject(forKey: SessionTokenStorage.legacyUserDefaultsKey)
    }

    func clearSessionToken() {
        if let current = sessionUserID {
            UserDefaults.standard.set(current, forKey: Self.previousSessionUserIDKey)
        }
        UserDefaults.standard.removeObject(forKey: Self.sessionUserIDKey)
        UserDefaults.standard.removeObject(forKey: "auth.sessionIsNewUser")
        KeychainTokenStore.clear()
        UserDefaults.standard.removeObject(forKey: SessionTokenStorage.legacyUserDefaultsKey)
    }

    struct BackendTaskResult: Decodable {
        var id: String?
        var help: TaskHelp?
        var status: String
        var memory_id: String?
        /// The kept-open browser session when the task paused for a
        /// human check; carried back on resume. Identifier only.
        var session_id: String?
        var extracted_items: [String]?
        var information_requests: [String]?
        var browser_trace: [BrowserTraceEvent]
        var log: [String]
    }

    private struct CreatedTask: Decodable { var id: String }
    private struct CredentialResponse: Decodable {
        var id: UUID
        var domain: String
        var username: String
    }

    /// Sends a secret ONCE to the server vault and returns only its reference.
    /// The secret is never written to disk on the device.
    func storeCredential(domain: String, username: String, secret: String) async throws -> CredentialRef {
        let body: [String: String] = ["domain": domain, "username": username, "secret": secret]
        let response: CredentialResponse = try await post("credentials", body: body)
        return CredentialRef(id: response.id, domain: response.domain, username: response.username)
    }

    private struct CreateTaskBody: Encodable {
        var kind: String
        var target_url: String
        var goal: String
        var title: String
        var drafted_payload: [String: String]
        var credential_id: String?
        var resume_session_id: String?
        var interaction_version = 1
        var mobile_task: AgentTask
    }

    func runTask(task: AgentTask) async throws -> BackendTaskResult {
        do { return try await submitTask(task) }
        catch {
            // A timeout or stale reply is not proof of failed execution. Read
            // the original task before offering any retry or repeating a write.
            if let current = try? await setupTasks().first(where: { $0.id == task.id }),
               current.backendTaskID != nil {
                return BackendTaskResult(id: current.backendTaskID, help: current.help,
                    status: current.status.rawValue, memory_id: current.memoryID?.uuidString,
                    session_id: current.browserSessionID, extracted_items: nil,
                    information_requests: current.informationRequests,
                    browser_trace: current.browserTrace, log: current.log)
            }
            throw error
        }
    }

    private func submitTask(_ task: AgentTask) async throws -> BackendTaskResult {
        if let backendID = task.backendTaskID, let reply = task.pendingReply {
            return try await post("tasks/\(backendID)/continue", body: reply)
        }
        let body = CreateTaskBody(
            kind: task.kind.rawValue, target_url: task.targetURLString, goal: task.goal,
            title: task.title, drafted_payload: task.draftedPayload,
            credential_id: task.credentialRefID?.uuidString.lowercased(),
            resume_session_id: task.browserSessionID, mobile_task: task)
        let created: BackendTaskResult = try await post("tasks", body: body)
        guard let id = created.id else { throw AuthClientError.unavailable }
        // Creation is idempotent: after an uncertain response read the original
        // task instead of repeating side effects or claiming nothing was sent.
        if created.status != "awaiting_approval" { return created }
        return try await post("tasks/\(id)/approve", body: [String: String]())
    }

    func setupTasks() async throws -> [AgentTask] {
        struct Row: Decodable { var mobile_task: AgentTask? }
        struct Response: Decodable { var tasks: [Row] }
        let response: Response = try await get("tasks")
        return response.tasks.compactMap(\.mobile_task)
    }

    func rejectTask(id: String, helpID: UUID? = nil) async throws {
        let _: BackendTaskResult = try await post("tasks/\(id)/reject", body: helpID.map { ["helpID": $0.uuidString] } ?? [:])
    }

    func createSession(url: String) async throws -> BrowserSessionSnapshot {
        try await post("sessions", body: ["url": url])
    }

    /// The live page of an already-open session — used so the user can
    /// finish a CAPTCHA/2FA/ID check in the very session that paused.
    func sessionSnapshot(sessionID: String) async throws -> BrowserSessionSnapshot {
        try await get("sessions/\(sessionID)")
    }

    func act(sessionID: String, action: String, target: String?, value: String?) async throws -> BrowserSessionSnapshot {
        var body: [String: String] = ["action": action]
        body["target"] = target
        body["value"] = value
        return try await post("sessions/\(sessionID)/act", body: body)
    }

    struct TranscriptLine: Encodable { var fromAgent: Bool; var text: String }
    private struct OnboardingBody: Encodable {
        var step: String
        var transcript: [TranscriptLine]
        var profile: EarningsProfile
        var contextSummary: String
    }

    // MARK: - Chat intent (model decides, app validates)

    struct ChatIntentContext: Encodable {
        struct SiteLine: Encodable { var id: String; var name: String; var domain: String; var state: String }
        struct MailLine: Encodable {
            var id: String; var senderDomain: String; var subject: String
            var summary: String; var highlights: [String]
        }
        var sites: [SiteLine]
        var inbox: [MailLine]
        var paused: Bool
    }

    struct ChatIntentActionDTO: Decodable, Equatable {
        var kind: String
        var siteId: String?
        var domain: String?
        var mailId: String?
        var act: Bool?
        var amount: Double?
    }

    private struct ChatIntentBody: Encodable {
        var transcript: [TranscriptLine]
        var profile: EarningsProfile
        var context: ChatIntentContext
    }

    private struct ChatIntentResponse: Decodable {
        var action: ChatIntentActionDTO?
        var simulated: Bool?
    }

    /// One short model call before any reply is written: does this
    /// message want something done? The answer is validated again
    /// in the store before anything runs.
    func chatIntent(transcript: [TranscriptLine], profile: EarningsProfile,
                    context: ChatIntentContext) async throws -> ChatIntentActionDTO? {
        let response: ChatIntentResponse = try await post(
            "onboarding/intent",
            body: ChatIntentBody(transcript: transcript, profile: profile, context: context))
        return response.action
    }

    /// The lifelong conversation thread (post-onboarding). Same SSE endpoint,
    /// "general" objective, with a plain-language context summary attached.
    func chatStream(transcript: [TranscriptLine], profile: EarningsProfile, contextSummary: String,
                    onDelta: @escaping @MainActor (String) -> Void) async throws -> OnboardingAssistantReply {
        try await stream(path: "onboarding/stream",
                         body: OnboardingBody(step: "general", transcript: transcript,
                                              profile: profile, contextSummary: contextSummary),
                         onDelta: onDelta)
    }

    /// Deletes a saved login. The trusted sign-in for the site is a
    /// separate thing and is deliberately left alone (and vice versa).
    @discardableResult
    func deleteCredential(id: UUID) async -> Bool {
        await delete(path: "credentials/\(id.uuidString.lowercased())")
    }

    private struct SessionProfilesResponse: Decodable { var profiles: [SessionProfileRef] }

    /// Metadata about trusted sign-ins — never the sign-ins themselves.
    func sessionProfiles() async throws -> [SessionProfileRef] {
        let response: SessionProfilesResponse = try await get("session-profiles")
        return response.profiles
    }

    /// Forgets a trusted sign-in. The saved login is kept.
    @discardableResult
    func deleteSessionProfile(domain: String) async -> Bool {
        await delete(path: "session-profiles/\(domain)")
    }

    // MARK: - Hygge email address (Brief 04, receive only)
    //
    // The address endpoints only ever describe the signed-in user's
    // own address. Filed mail is summary-level; codes never come
    // to the device. There is no send call here by design.

    func hyggeEmailAddress() async throws -> HyggeEmailAddress? {
        let response: HyggeEmailAddressResponse = try await get("email/address")
        return response.hyggeEmail
    }

    func allocateHyggeEmailAddress() async throws -> HyggeEmailAddress? {
        let response: HyggeEmailAddressResponse = try await post("email/address", body: [String: String]())
        return response.hyggeEmail
    }

    private struct FiledEmailResponse: Decodable { var messages: [FiledEmailSummary] }

    func filedEmail() async throws -> [FiledEmailSummary] {
        let response: FiledEmailResponse = try await get("email/messages")
        return response.messages
    }

    private struct EmailDecisionBody: Encodable { var senderDomain: String; var choice: String }
    private struct EmailDecisionAck: Decodable { var remembered: Bool? }

    /// Remembers how one sender's mail should be treated from now
    /// on ("work", "file", or "ignore"). Returns the fresh inbox so
    /// the caller can update in one step.
    func decideEmailSender(domain: String, choice: String) async -> [FiledEmailSummary]? {
        let ack: EmailDecisionAck? = try? await post(
            "email/decision", body: EmailDecisionBody(senderDomain: domain, choice: choice))
        guard ack?.remembered == true else { return nil }
        return try? await filedEmail()
    }

    // MARK: - Push notifications (Brief 07)
    //
    // The device token is registered for the signed-in user only;
    // the session in the Authorization header is the identity, the
    // token itself proves nothing. Registration is idempotent, so a
    // refresh on every foregrounding is safe. Unregistering happens
    // on sign-out, before the session goes away.

    private struct DeviceTokenAck: Decodable { var registered: Bool? }
    private struct DeviceTokenBody: Encodable { var token: String; var platform: String }

    @discardableResult
    func registerDeviceToken(_ token: String) async -> Bool {
        guard DeviceTokenEncoding.isPlausible(token) else { return false }
        let ack: DeviceTokenAck? = try? await post(
            "device-tokens",
            body: DeviceTokenBody(token: token.lowercased(), platform: "ios"))
        return ack?.registered == true
    }

    @discardableResult
    func unregisterDeviceToken(_ token: String) async -> Bool {
        // Body-only: device tokens never travel in URL paths (logs).
        var request = URLRequest(url: baseURL.appendingPathComponent("device-tokens"))
        request.httpMethod = "DELETE"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !apiToken.isEmpty { request.setValue("Bearer \(apiToken)", forHTTPHeaderField: "Authorization") }
        request.httpBody = try? JSONEncoder().encode(
            DeviceTokenBody(token: token.lowercased(), platform: "ios"))
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse else { return false }
        return (200...299).contains(http.statusCode)
    }

    private func delete(path: String) async -> Bool {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "DELETE"
        if !apiToken.isEmpty { request.setValue("Bearer \(apiToken)", forHTTPHeaderField: "Authorization") }
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse else { return false }
        return (200...299).contains(http.statusCode)
    }

    /// Before sign-in (it is the last onboarding step) the scripted
    /// conversation runs on the anonymous preview routes, which keep
    /// no server-side user state; after sign-in the same calls go to
    /// the user's own conversation as before.
    private var onboardingPathPrefix: String { hasSessionToken ? "onboarding" : "onboarding/preview" }

    func onboardingMessage(step: OnboardingStep, transcript: [TranscriptLine],
                           profile: EarningsProfile) async throws -> OnboardingAssistantReply {
        try await post("\(onboardingPathPrefix)/message",
                       body: OnboardingBody(step: step.backendStep.rawValue, transcript: transcript, profile: profile, contextSummary: ""))
    }

    private struct StreamEvent: Decodable {
        var type: String
        var text: String?
        var data: OnboardingAssistantReply?
    }

    /// Streams one onboarding turn over SSE: onDelta receives reply fragments
    /// as the model generates them (already extracted from the JSON stream
    /// server-side — raw JSON is never rendered).
    func onboardingStream(step: OnboardingStep, transcript: [TranscriptLine],
                          profile: EarningsProfile,
                          onDelta: @escaping @MainActor (String) -> Void) async throws -> OnboardingAssistantReply {
        try await stream(path: "\(onboardingPathPrefix)/stream",
                         body: OnboardingBody(step: step.backendStep.rawValue, transcript: transcript, profile: profile, contextSummary: ""),
                         onDelta: onDelta)
    }

    private func stream(path: String, body: OnboardingBody,
                        onDelta: @escaping @MainActor (String) -> Void) async throws -> OnboardingAssistantReply {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        if !apiToken.isEmpty { request.setValue("Bearer \(apiToken)", forHTTPHeaderField: "Authorization") }
        request.timeoutInterval = 90
        request.httpBody = try JSONEncoder().encode(body)
        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        let decoder = JSONDecoder()
        for try await line in bytes.lines {
            guard line.hasPrefix("data:") else { continue }
            let json = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            guard let data = json.data(using: .utf8),
                  let event = try? decoder.decode(StreamEvent.self, from: data) else { continue }
            if event.type == "reply-delta", let text = event.text {
                await onDelta(text)
            } else if event.type == "final", let reply = event.data {
                return reply
            }
        }
        throw URLError(.cannotParseResponse)
    }

    struct SiteProposalDTO: Decodable { var name: String; var url: String; var rationale: String }
    private struct SiteProposalsResponse: Decodable { var proposals: [SiteProposalDTO] }
    private struct SiteProposalsBody: Encodable {
        var category: String
        var locationLabel: String
        var interests: [String]
    }

    func siteProposals(category: OpportunityCategory, profile: EarningsProfile) async throws -> [SiteProposalDTO] {
        let response: SiteProposalsResponse = try await post(
            "site-proposals",
            body: SiteProposalsBody(category: category.rawValue, locationLabel: profile.locationLabel,
                                    interests: profile.interests.map(\.rawValue) + profile.customInterests))
        return response.proposals
    }

    // MARK: - Server-side state (Brief 01)
    //
    // The per-user state endpoints are the source of truth; these
    // calls carry model JSON only — never a credential secret (refs
    // come from the vault metadata endpoints above). State traffic
    // uses ISO-8601 dates in both directions so a second device
    // decodes exactly what the first one wrote.

    private static func stateEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }

    private static func stateDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        // Server timestamps carry fractional seconds; the plain
        // .iso8601 strategy rejects those on older OS releases.
        decoder.dateDecodingStrategy = HyggeISO8601.dateDecodingStrategy
        return decoder
    }

    func exportState() async throws -> ServerExport {
        try await stateGet("state/export")
    }

    func stateCounts() async throws -> StateCounts {
        try await stateGet("state/counts")
    }

    @discardableResult
    func importState(_ payload: ServerImport) async throws -> ImportResult {
        try await statePost("state/import", body: payload)
    }

    /// Hard deletes (e.g. a deleted belief) must leave the server too,
    /// or the next pull would resurrect them. Best-effort by design:
    /// the caller reports sync trouble through its normal push path.
    func deleteStateRow(entityPath: String, id: String) async {
        var request = URLRequest(url: baseURL.appendingPathComponent("\(entityPath)/\(id)"))
        request.httpMethod = "DELETE"
        request.timeoutInterval = 8
        if !apiToken.isEmpty { request.setValue("Bearer \(apiToken)", forHTTPHeaderField: "Authorization") }
        _ = try? await URLSession.shared.data(for: request)
    }

    struct CredentialDTO: Decodable {
        var id: UUID
        var domain: String
        var username: String
    }
    private struct CredentialsResponse: Decodable { var credentials: [CredentialDTO] }

    /// Vault references for a fresh install (metadata only, as always).
    func listCredentialRefs() async throws -> [CredentialRef] {
        let response: CredentialsResponse = try await get("credentials")
        return response.credentials.map { CredentialRef(id: $0.id, domain: $0.domain, username: $0.username) }
    }

    struct MemoryDTO: Decodable {
        var id: UUID
        var domain: String
        var kind: String
        var hints: [String]
        var successCount: Int
        var failureCount: Int
    }
    private struct MemoriesResponse: Decodable { var memories: [MemoryDTO] }

    /// Advisory site know-how for a fresh install (hints, never steps).
    func listSiteMemory() async throws -> SiteMemoryRepository {
        let response: MemoriesResponse = try await get("memory")
        let memories = response.memories.compactMap { dto -> SiteMemory? in
            guard let kind = MemoryKind(rawValue: dto.kind) else { return nil }
            return SiteMemory(id: dto.id, domain: dto.domain, kind: kind, hints: dto.hints,
                              successCount: dto.successCount, failureCount: dto.failureCount)
        }
        return SiteMemoryRepository(memories: memories)
    }

    struct ProfilePhotoReceipt: Decodable { let version: String }

    func fetchProfilePhoto() async throws -> Data? {
        let (data, response) = try await profilePhotoRequest(method: "GET")
        if response.statusCode == 404 { return nil }
        guard response.statusCode == 200, response.mimeType == "image/jpeg",
              data.count <= 512 * 1024 else { throw URLError(.badServerResponse) }
        return data
    }

    /// Returns false only when a legacy device-local photo must yield to an
    /// existing server photo. Other errors leave the upload pending for retry.
    func uploadProfilePhoto(_ data: Data, onlyIfMissing: Bool) async throws -> Bool {
        let (body, response) = try await profilePhotoRequest(method: "PUT", data: data, onlyIfMissing: onlyIfMissing)
        if onlyIfMissing && response.statusCode == 412 { return false }
        guard response.statusCode == 200 else { throw URLError(.badServerResponse) }
        _ = try JSONDecoder().decode(ProfilePhotoReceipt.self, from: body)
        return true
    }

    func removeProfilePhoto() async throws {
        let (_, response) = try await profilePhotoRequest(method: "DELETE")
        guard response.statusCode == 204 else { throw URLError(.badServerResponse) }
    }

    private func profilePhotoRequest(method: String, data: Data? = nil, onlyIfMissing: Bool = false) async throws -> (Data, HTTPURLResponse) {
        guard hasSessionToken else { throw URLError(.userAuthenticationRequired) }
        var request = URLRequest(url: baseURL.appendingPathComponent("profile/photo"))
        request.httpMethod = method
        request.timeoutInterval = 20
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Bearer \(apiToken)", forHTTPHeaderField: "Authorization")
        if let data {
            request.httpBody = data
            request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        }
        if onlyIfMissing { request.setValue("*", forHTTPHeaderField: "If-None-Match") }
        let (body, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (body, http)
    }

    private func stateGet<Response: Decodable>(_ path: String) async throws -> Response {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.timeoutInterval = 15
        if !apiToken.isEmpty { request.setValue("Bearer \(apiToken)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try Self.stateDecoder().decode(Response.self, from: data)
    }

    private func statePost<Response: Decodable, Body: Encodable>(_ path: String, body: Body) async throws -> Response {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !apiToken.isEmpty { request.setValue("Bearer \(apiToken)", forHTTPHeaderField: "Authorization") }
        request.timeoutInterval = 20
        request.httpBody = try Self.stateEncoder().encode(body)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try Self.stateDecoder().decode(Response.self, from: data)
    }

    struct Health: Decodable {
        var ok: Bool
        var browser: String?
        var llm: String?
    }

    func health() async throws -> Health {
        try await get("health")
    }

    /// Reachability + token validity, for the settings screen and chat banner.
    func testConnection() async throws -> Health {
        let health = try await health()
        // Before sign-in there is nothing to validate yet, so
        // reachability alone decides (the onboarding banner must not
        // read "offline" just because no account exists yet).
        guard hasSessionToken else { return health }
        // /tasks requires the bearer token when one is configured server-side.
        struct AnyTaskList: Decodable { struct Item: Decodable { var id: String }; var tasks: [Item] }
        let _: AnyTaskList = try await get("tasks")
        return health
    }

    // MARK: - Identity (Brief 00)

    struct AuthSessionResponse: Decodable {
        var token: String
        var expiresAt: String
        var userId: String
        var isNewUser: Bool?
        var methods: [LinkedLoginMethod]?
    }

    private struct MethodsResponse: Decodable { var methods: [LinkedLoginMethod] }
    private struct AppleBody: Encodable { var identityToken: String; var nonce: String?; var displayName: String? }
    private struct EmailRequestBody: Encodable { var email: String }
    private struct MagicConsumeBody: Encodable { var token: String }
    private struct MagicConsumeResponse: Decodable {
        var linked: Bool?
        var token: String?
        var expiresAt: String?
        var userId: String?
        var isNewUser: Bool?
        var methods: [LinkedLoginMethod]?
    }
    private struct MagicRequestAck: Decodable { var ok: Bool; var message: String? }

    /// Sign-up/sign-in with Apple: the identity token is verified by
    /// the backend, which returns the app session kept in Keychain.
    @discardableResult
    func signInWithApple(identityToken: String, nonce: String?, displayName: String?) async throws -> AuthSessionResponse {
        let session: AuthSessionResponse = try await authRequest(
            "auth/apple", method: "POST",
            body: AppleBody(identityToken: identityToken, nonce: nonce, displayName: displayName))
        setSessionToken(session.token, userID: session.userId)
        UserDefaults.standard.set(session.isNewUser ?? false, forKey: "auth.sessionIsNewUser")
        return session
    }

    /// Asks for a sign-in link by email. The answer is the same
    /// whether or not the address has an account, so the returned
    /// sentence is all the UI ever learns. While signed in, the
    /// link later attaches this email to the current account.
    @discardableResult
    func requestMagicLink(email: String) async throws -> String {
        let ack: MagicRequestAck = try await authRequest(
            "auth/email/request", method: "POST",
            body: EmailRequestBody(email: HyggeAuth.normalizeEmail(email)))
        return ack.message ?? "If that email can sign in, a sign-in link is on its way."
    }

    /// Consumes a tapped magic link. Signed out: a session comes
    /// back and lands in the Keychain. Signed in (link mode): the
    /// refreshed method list comes back instead.
    @discardableResult
    func consumeMagicLink(token: String) async throws -> [LinkedLoginMethod]? {
        let response: MagicConsumeResponse = try await authRequest(
            "auth/email/consume", method: "POST",
            body: MagicConsumeBody(token: token))
        if let sessionToken = response.token {
            setSessionToken(sessionToken, userID: response.userId)
            UserDefaults.standard.set(response.isNewUser ?? false, forKey: "auth.sessionIsNewUser")
            return response.linked == true ? response.methods ?? [] : nil
        }
        return response.methods ?? []
    }

    func signInWithPassword(email: String, password: String) async throws {
        let session: AuthSessionResponse = try await authRequest("auth/email/password", method: "POST",
            body: ["email": HyggeAuth.normalizeEmail(email), "password": password])
        setSessionToken(session.token, userID: session.userId)
        UserDefaults.standard.set(session.isNewUser ?? false, forKey: "auth.sessionIsNewUser")
    }

    struct PasswordConfirmationReceipt: Decodable {
        var id: String
        var email: String
        var expiresAt: String
    }

    func requestPasswordConfirmation(methodID: String, password: String) async throws -> PasswordConfirmationReceipt {
        try await authRequest("auth/methods/password/request", method: "POST",
            body: ["methodId": methodID, "password": password])
    }

    func confirmPassword(token: String) async throws {
        let session: AuthSessionResponse = try await authRequest("auth/methods/password/confirm", method: "POST",
            body: ["token": token])
        setSessionToken(session.token, userID: session.userId)
        UserDefaults.standard.set(false, forKey: "auth.sessionIsNewUser")
    }

    func cancelPasswordConfirmation(id: String) async throws {
        struct Ack: Decodable { var ok: Bool }
        let _: Ack = try await authRequest("auth/methods/password/cancel", method: "POST", body: ["id": id])
    }

    func setEmailPassword(methodID: String, password: String) async throws -> [LinkedLoginMethod] {
        let response: MethodsResponse = try await authRequest("auth/methods/password", method: "POST",
            body: ["methodId": methodID, "password": password])
        return response.methods
    }

    func fetchLoginMethods() async throws -> [LinkedLoginMethod] {
        let response: MethodsResponse = try await authRequest("auth/methods", method: "GET", body: Optional<String>.none)
        return response.methods
    }

    @discardableResult
    func linkApple(identityToken: String, nonce: String?) async throws -> [LinkedLoginMethod] {
        let response: MethodsResponse = try await authRequest(
            "auth/methods/link/apple", method: "POST",
            body: AppleBody(identityToken: identityToken, nonce: nonce, displayName: nil))
        return response.methods
    }

    @discardableResult
    func unlinkLoginMethod(id: String) async throws -> [LinkedLoginMethod] {
        let response: MethodsResponse = try await authRequest("auth/methods/\(id)", method: "DELETE", body: Optional<String>.none)
        return response.methods
    }


    /// Revokes the session, then forgets it on this device either way.
    func signOut() async {
        struct SignedOut: Decodable { var ok: Bool }
        let _: SignedOut? = try? await authRequest("auth/signout", method: "POST", body: [String: String]())
        clearSessionToken()
    }

    private struct AuthErrorBody: Decodable { var error: String?; var message: String? }

    /// Like get/post, but surfaces the backend's plain-language message
    /// instead of collapsing every failure into one opaque error.
    private func authRequest<Response: Decodable, Body: Encodable>(
        _ path: String, method: String, body: Body
    ) async throws -> Response {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = method
        request.timeoutInterval = 20
        if !apiToken.isEmpty { request.setValue("Bearer \(apiToken)", forHTTPHeaderField: "Authorization") }
        if method == "POST" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw AuthClientError.unavailable }
        guard (200...299).contains(http.statusCode) else {
            if let decoded = try? JSONDecoder().decode(AuthErrorBody.self, from: data),
               let message = decoded.message, !message.isEmpty {
                if decoded.error == "reauthentication_required" { throw AuthClientError.reauthenticationRequired }
                throw AuthClientError.message(message)
            }
            throw AuthClientError.unavailable
        }
        return try JSONDecoder().decode(Response.self, from: data)
    }

    private func get<Response: Decodable>(_ path: String) async throws -> Response {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.timeoutInterval = 8
        if !apiToken.isEmpty { request.setValue("Bearer \(apiToken)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(Response.self, from: data)
    }

    private func post<Response: Decodable, Body: Encodable>(_ path: String, body: Body) async throws -> Response {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !apiToken.isEmpty { request.setValue("Bearer \(apiToken)", forHTTPHeaderField: "Authorization") }
        request.timeoutInterval = path.hasPrefix("tasks/") ? 180 : 20
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = HyggeISO8601.dateDecodingStrategy
        return try decoder.decode(Response.self, from: data)
    }
}
