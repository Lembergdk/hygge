import Foundation

/// Talks to the Hygge agent service (backend/agent-service). The service
/// owns the cloud browser, the skills repository, and the credential vault.
/// Every call is optional from the app's perspective: when unreachable, the
/// store falls back to the local simulated runner and says so in the log.
struct BackendClient {
    /// Configurable in Profile/onboarding settings so a phone on the same
    /// Wi-Fi can reach the service on the developer's Mac (LAN dev mode).
    var baseURL: URL {
        let raw = UserDefaults.standard.string(forKey: "backendBaseURL") ?? "http://127.0.0.1:8787"
        return URL(string: raw) ?? URL(string: "http://127.0.0.1:8787")!
    }
    var apiToken: String { UserDefaults.standard.string(forKey: "backendToken") ?? "" }

    struct BackendTaskResult: Decodable {
        var status: String
        var memory_id: String?
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
    }

    func runTask(task: AgentTask) async throws -> BackendTaskResult {
        let body = CreateTaskBody(
            kind: task.kind.rawValue, target_url: task.targetURLString, goal: task.goal,
            title: task.title, drafted_payload: task.draftedPayload,
            credential_id: task.credentialRefID?.uuidString.lowercased())
        let created: CreatedTask = try await post("tasks", body: body)
        return try await post("tasks/\(created.id)/approve", body: [String: String]())
    }

    func createSession(url: String) async throws -> BrowserSessionSnapshot {
        try await post("sessions", body: ["url": url])
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
    }

    func onboardingMessage(step: OnboardingStep, transcript: [TranscriptLine],
                           profile: EarningsProfile) async throws -> OnboardingAssistantReply {
        try await post("onboarding/message",
                       body: OnboardingBody(step: step.rawValue, transcript: transcript, profile: profile))
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
        var request = URLRequest(url: baseURL.appendingPathComponent("onboarding/stream"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        if !apiToken.isEmpty { request.setValue("Bearer \(apiToken)", forHTTPHeaderField: "Authorization") }
        request.timeoutInterval = 90
        request.httpBody = try JSONEncoder().encode(
            OnboardingBody(step: step.rawValue, transcript: transcript, profile: profile))
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
        struct TasksProbe: Decodable { var tasks: [String]? }
        // /tasks requires the bearer token when one is configured server-side.
        struct AnyTaskList: Decodable { struct Item: Decodable { var id: String }; var tasks: [Item] }
        let _: AnyTaskList = try await get("tasks")
        return health
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
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(Response.self, from: data)
    }
}
