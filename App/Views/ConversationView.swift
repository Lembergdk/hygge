import SwiftUI

/// The one continuous thread with Hygge — onboarding happened here, and this
/// is the same conversation forever after. Opened by the floating flame.
struct ConversationView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var input = ""
    @State private var streamingText: String?
    @State private var isThinking = false
    @State private var pendingAction: ChatAction?

    var body: some View {
        NavigationStack {
            ZStack {
                HyggeTheme.paper.ignoresSafeArea()
                VStack(spacing: 0) {
                    ScrollViewReader { proxy in
                        ScrollView {
                            VStack(alignment: .leading, spacing: 13) {
                                ForEach(store.chatTranscript) { entry in
                                    bubble(entry).id(entry.id)
                                }
                                if isThinking && streamingText == nil {
                                    HStack(alignment: .bottom, spacing: 7) {
                                        FlameMark(size: 26)
                                        ThinkingDotsShared()
                                        Text("Thinking…").font(.caption).foregroundStyle(HyggeTheme.secondary)
                                        Spacer()
                                    }
                                }
                                if let streamingText {
                                    agentBubble(streamingText)
                                }
                                if let pendingAction {
                                    confirmationCard(pendingAction)
                                }
                                Color.clear.frame(height: 10).id("bottom")
                            }
                            .padding(.horizontal, 18).padding(.top, 22)
                        }
                        .scrollDismissesKeyboard(.interactively)
                        .onChange(of: store.chatTranscript.count) { _, _ in
                            withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                        }
                        .onChange(of: streamingText?.count ?? 0) { _, _ in
                            proxy.scrollTo("bottom", anchor: .bottom)
                        }
                    }
                    composer
                }
            }
        }
    }

    private var composer: some View {
        HStack(spacing: 9) {
            TextField("Message Hygge…", text: $input, axis: .vertical)
                .lineLimit(1...4)
                .padding(.horizontal, 16).padding(.vertical, 12)
                .background(HyggeTheme.card, in: Capsule())
                .overlay(Capsule().stroke(HyggeTheme.hairline, lineWidth: 1))
                .onSubmit { Task { await send() } }
            Button { Task { await send() } } label: {
                Image(systemName: "paperplane.fill")
                    .font(.system(size: 16, weight: .semibold)).foregroundStyle(.white)
                    .frame(width: 44, height: 44)
                    .background(HyggeTheme.sageDeep, in: Circle())
            }
            .disabled(input.trimmingCharacters(in: .whitespaces).isEmpty || isThinking)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private var userInitial: String {
        let name = store.profile.displayName.trimmingCharacters(in: .whitespaces)
        return String((name.isEmpty ? "You" : name).prefix(1)).uppercased()
    }

    private var userAvatar: some View {
        ZStack {
            Circle().fill(HyggeTheme.sageTint).frame(width: 30, height: 30)
            Text(userInitial)
                .font(.system(.caption, design: .rounded, weight: .bold))
                .foregroundStyle(HyggeTheme.ink)
        }
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func bubble(_ entry: ChatEntry) -> some View {
        if entry.fromAgent {
            agentBubble(entry.text)
        } else {
            HStack(alignment: .bottom, spacing: 7) {
                Spacer(minLength: 44)
                Text(entry.text)
                    .font(.body).foregroundStyle(HyggeTheme.ink).lineSpacing(3)
                    .padding(.horizontal, 15).padding(.vertical, 12)
                    .background(HyggeTheme.sageTint, in: UnevenRoundedRectangle(
                        topLeadingRadius: 20, bottomLeadingRadius: 20,
                        bottomTrailingRadius: 6, topTrailingRadius: 20))
                userAvatar
            }
        }
    }

    private func agentBubble(_ text: String) -> some View {
        HStack(alignment: .bottom, spacing: 7) {
            FlameMark(size: 26)
            Text(text.isEmpty ? " " : text)
                .font(.body).foregroundStyle(HyggeTheme.ink).lineSpacing(3)
                .padding(.horizontal, 15).padding(.vertical, 12)
                .background(HyggeTheme.card, in: UnevenRoundedRectangle(
                    topLeadingRadius: 6, bottomLeadingRadius: 20,
                    bottomTrailingRadius: 20, topTrailingRadius: 20))
                .overlay(UnevenRoundedRectangle(
                    topLeadingRadius: 6, bottomLeadingRadius: 20,
                    bottomTrailingRadius: 20, topTrailingRadius: 20)
                    .stroke(HyggeTheme.hairline, lineWidth: 1))
            Spacer(minLength: 36)
        }
    }

    private func send() async {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isThinking else { return }
        input = ""
        store.appendChat(fromAgent: false, text: text)
        // Explicit commands are structured actions, validated by the app.
        // Safe ones run at once; consequential ones wait for confirmation.
        if let action = ChatActionParser.parse(text, sites: store.sites) {
            if action.requiresConfirmation {
                pendingAction = action
                return
            }
            let replyText = await store.performChatAction(action)
            store.appendChat(fromAgent: true, text: replyText)
            return
        }
        isThinking = true
        streamingText = nil
        defer { isThinking = false; streamingText = nil }
        let transcript = store.chatTranscript.map {
            BackendClient.TranscriptLine(fromAgent: $0.fromAgent, text: $0.text)
        }
        do {
            let reply = try await store.backend.chatStream(
                transcript: transcript, profile: store.profile,
                contextSummary: store.conversationContextSummary
            ) { delta in
                if streamingText == nil { streamingText = "" }
                streamingText! += delta
            }
            store.appendChat(fromAgent: true, text: reply.reply)
            // Nothing the model infers is applied silently. Inferred facts
            // become quoted belief proposals the user confirms in profile.
            proposeBeliefs(from: reply.extracted)
        } catch {
            store.appendChat(fromAgent: true,
                             text: "I'm offline right now, so I can't think that through. Your message is saved here — ask me again when you're back online.")
        }
    }

    private func proposeBeliefs(from patch: EarningsProfilePatch) {
        var proposed = 0
        if let skills = patch.skills, !skills.isEmpty {
            store.proposeBelief(sentence: "Also good at: \(skills.joined(separator: ", "))",
                                source: .guessedFromChat, confidence: 0.7); proposed += 1
        }
        if let availability = patch.availabilityNotes, !availability.isEmpty {
            store.proposeBelief(sentence: "Usually free: \(availability)",
                                source: .youSaidIt, confidence: 0.85); proposed += 1
        }
        if let location = patch.locationLabel, !location.isEmpty,
           location != store.profile.locationLabel {
            store.proposeBelief(sentence: "Now based in \(location)",
                                source: .youSaidIt, confidence: 0.85); proposed += 1
        }
        if let interests = patch.interests, !interests.isEmpty {
            store.proposeBelief(sentence: "Also enjoys: \(interests.map(\.activityLabel).joined(separator: ", ").lowercased())",
                                source: .guessedFromChat, confidence: 0.65); proposed += 1
        }
        if proposed > 0 {
            store.appendChat(fromAgent: true,
                             text: "I've noted \(proposed == 1 ? "that" : "those") as a belief to check — it only counts once you confirm it in your profile.")
        }
    }

    private func actionQuestion(_ action: ChatAction) -> String {
        switch action {
        case .stopSite(let siteID):
            return "Stop watching \(store.siteName(id: siteID)) completely?"
        case .changeFloor(let floor):
            return "Set your lowest rate to $\(Int(floor))/hr?"
        case .approveFirst:
            if let task = store.tasks.first(where: { $0.status == .awaitingApproval }) {
                return "Approve and send “\(task.title)”?"
            }
            return "Approve the first waiting draft?"
        case .bookFirst:
            return "Go ahead with the waiting booking?"
        case .pause, .resume, .explainDropped:
            return "Do that now?"
        }
    }

    /// Consequential chat actions render as an inline confirm card in the
    /// thread — the words alone never execute them.
    private func confirmationCard(_ action: ChatAction) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Just to be sure")
                .font(.caption.weight(.bold)).foregroundStyle(HyggeTheme.ember)
            Text(actionQuestion(action))
                .font(.subheadline.weight(.semibold)).foregroundStyle(HyggeTheme.ink)
            HStack(spacing: 9) {
                Button("Yes, do it") {
                    pendingAction = nil
                    Task {
                        let replyText = await store.performChatAction(action)
                        store.appendChat(fromAgent: true, text: replyText)
                    }
                }
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 15).padding(.vertical, 9)
                .background(HyggeTheme.ember, in: Capsule()).foregroundStyle(.white)
                Button("Not now") {
                    pendingAction = nil
                    store.appendChat(fromAgent: true, text: "Okay — nothing changed.")
                }
                .font(.subheadline.weight(.medium)).foregroundStyle(HyggeTheme.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(15).hyggeCard(radius: 18)
    }
}

/// Shared thinking dots (also usable outside onboarding).
struct ThinkingDotsShared: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        TimelineView(.animation(minimumInterval: 0.1)) { context in
            HStack(spacing: 6) {
                ForEach(0..<3, id: \.self) { index in
                    let phase = reduceMotion ? 0.5
                        : 0.5 + 0.5 * sin(context.date.timeIntervalSinceReferenceDate * 3.2 - Double(index) * 0.55)
                    Circle().fill(HyggeTheme.ember.opacity(0.35 + 0.65 * phase))
                        .frame(width: 8, height: 8)
                        .scaleEffect(0.75 + 0.35 * phase)
                        .offset(y: -3 * phase)
                }
            }
        }
        .frame(width: 44, height: 14)
        .accessibilityLabel("Hygge is thinking")
    }
}
