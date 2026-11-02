import Foundation

/// A sign-in failure in words the user can act on.
enum AuthClientError: LocalizedError {
    case message(String)
    case unavailable

    var errorDescription: String? {
        switch self {
        case .message(let message): return message
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

    func setSessionToken(_ token: String) {
        _ = KeychainTokenStore.write(token)
        UserDefaults.standard.removeObject(forKey: SessionTokenStorage.legacyUserDefaultsKey)
    }

    func clearSessionToken() {
        KeychainTokenStore.clear()
        UserDefaults.standard.removeObject(forKey: SessionTokenStorage.legacyUserDefaultsKey)
    }

    struct BackendTaskResult: Decodable {
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
    }

    func runTask(task: AgentTask) async throws -> BackendTaskResult {
        let body = CreateTaskBody(
            kind: task.kind.rawValue, target_url: task.targetURLString, goal: task.goal,
            title: task.title, drafted_payload: task.draftedPayload,
            credential_id: task.credentialRefID?.uuidString.lowercased(),
            resume_session_id: task.browserSessionID)
        let created: CreatedTask = try await post("tasks", body: body)
        return try await post("tasks/\(created.id)/approve", body: [String: String]())
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
                                    interests: profile.interests.map(\.rawValue)))
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
        setSessionToken(session.token)
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
            setSessionToken(sessionToken)
            return nil
        }
        return response.methods ?? []
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
        request.timeoutInterval = 20
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
