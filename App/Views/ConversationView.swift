import SwiftUI

/// The one continuous thread with Hygge — onboarding happened here, and this
/// is the same conversation forever after. Opened by the floating flame.
struct ConversationView: View {
    /// Sheet presentations keep the paper background; the feed's speech
    /// bubble passes the card color so it lifts off the feed behind it.
    var background: Color = HyggeTheme.paper
    /// The speech bubble sits right on top of him — a name header there
    /// only repeats what the flame below already says.
    var showsHeader: Bool = true
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var input = ""
    @State private var streamingText: String?
    @State private var isThinking = false
    @State private var pendingAction: ChatAction?
    @State private var replyTarget: TaskReplyTarget?
    @State private var credentialRequest: AppStore.CredentialSaveRequest?
    @State private var takeBrowserControl = false
    @State private var browserTask: AgentTask?
    @FocusState private var composerFocused: Bool
    @AppStorage("preferredMailAppScheme") private var preferredMailApp = "message://"
    @State private var mailError: String?

    private struct TaskReplyTarget {
        var taskID: UUID
        var helpID: UUID
        var question: String
    }

    var body: some View {
        NavigationStack {
            ZStack {
                background.ignoresSafeArea()
                VStack(spacing: 0) {
                    if showsHeader {
                        HStack(spacing: 10) {
                            AnimatedFlame(animation: avatarAnimation, size: 36)
                            Text("Hygge").font(.title3.weight(.bold))
                            Spacer()
                        }.foregroundStyle(HyggeTheme.ink).padding(.horizontal, 20).padding(.top, 18)
                    }
                    ScrollViewReader { proxy in
                        ScrollView {
                            VStack(alignment: .leading, spacing: 13) {
                                ForEach(store.chatTranscript) { entry in
                                    VStack(alignment: .leading, spacing: 8) {
                                        bubble(entry)
                                        if let taskID = entry.taskID,
                                           let task = store.tasks.first(where: { $0.id == taskID }),
                                           entry.helpID != nil {
                                            if task.browserSessionID != nil,
                                               store.chatTranscript.last(where: { $0.taskID == task.id })?.id == entry.id {
                                                BrowserLiveAttachment(task: task) { takeBrowserControl = false; browserTask = task }.padding(.leading, 33)
                                            }
                                            if task.needsChatHelp, let help = task.help, help.id == entry.helpID {
                                                taskHelpCard(task, help: help)
                                            } else if task.status == .running || task.status == .approved {
                                                ProgressView("I’m continuing…").padding(.leading, 33)
                                            } else {
                                                Text(task.status == .succeeded ? "Done — this step is finished." : task.status == .rejected ? "Not continued." : task.needsChatHelp ? "There’s an updated request below." : "Answered.")
                                                    .font(.caption).foregroundStyle(HyggeTheme.secondary).padding(.leading, 33)
                                            }
                                        }
                                    }.id(entry.id)
                                }
                                if isThinking && streamingText == nil {
                                    HStack(alignment: .bottom, spacing: 7) {
                                        AnimatedFlame(animation: avatarAnimation, size: 26)
                                        ThinkingDotsShared()
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
                        .onAppear {
                            store.markChatRead()
                            for task in store.chatHelpTasks { store.surfaceTaskHelp(taskID: task.id) }
                            if let id = store.conversationTaskID,
                               let entry = store.chatTranscript.last(where: { $0.taskID == id }) {
                                proxy.scrollTo(entry.id, anchor: .top)
                                prepareReply(to: id)
                            } else { proxy.scrollTo("bottom", anchor: .bottom) }
                        }
                        .onChange(of: store.conversationTaskID) { _, id in
                            if let entry = store.chatTranscript.last(where: { $0.taskID == id }) {
                                proxy.scrollTo(entry.id, anchor: .top)
                            }
                        }
                        .onChange(of: store.chatTranscript.count) { _, _ in
                            store.markChatRead()
                            withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                            if let id = store.chatTranscript.last?.taskID { prepareReply(to: id) }
                        }
                        .onDisappear { store.markChatRead() }
                        .onChange(of: streamingText?.count ?? 0) { _, _ in
                            proxy.scrollTo("bottom", anchor: .bottom)
                        }
                    }
                    if let target = replyTarget {
                        HStack {
                            Text("Replying: \(target.question)").font(.caption).lineLimit(2)
                            Spacer()
                            Button("Cancel") { replyTarget = nil }
                        }.foregroundStyle(HyggeTheme.secondary).padding(.horizontal, 18)
                    }
                    composer
                }
            }
        }
        .sheet(item: $credentialRequest) { request in
            CredentialSaveSheet(siteName: request.siteName, domain: request.domain) { saved in
                store.finishCredentialSave(request, saved: saved)
            }.presentationDragIndicator(.visible)
        }
        .sheet(item: $browserTask) { task in
            CloudBrowserView(urlString: task.targetURLString, existingSessionID: task.browserSessionID,
                             taskID: task.id, takeControlOnOpen: takeBrowserControl)
        }
        .task { await store.observeBrowserTasks() }
    }

    private var avatarAnimation: FlameAnimation {
        if !store.chatHelpTasks.isEmpty { return .notify }
        return store.isAgentWorking || isThinking ? .laptop : .walk
    }

    private var composer: some View {
        HStack(spacing: 9) {
            TextField(replyTarget == nil ? "Message Hygge…" : "Your reply…", text: $input, axis: .vertical)
                .focused($composerFocused)
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
            AnimatedFlame(animation: avatarAnimation, size: 26)
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
        if let target = replyTarget {
            guard store.tasks.first(where: { $0.id == target.taskID })?.help?.id == target.helpID else {
                input = text
                replyTarget = nil
                return
            }
            replyTarget = nil
            isThinking = true
            await store.replyToTask(taskID: target.taskID, helpID: target.helpID, answers: [target.question: text])
            isThinking = false
            return
        }
        store.appendChat(fromAgent: false, text: text)
        // Understanding is model-led: one short intent call decides
        // whether this message wants something done (referents and
        // all), and the store validates whatever it proposes before
        // anything runs. The strict grammar and the deterministic
        // email resolver remain as offline fallbacks underneath.
        isThinking = true
        switch await store.modelIntent(for: text) {
        case .handled(let replyText):
            isThinking = false
            store.appendChat(fromAgent: true, text: replyText)
            return
        case .needsConfirmation(let action):
            isThinking = false
            pendingAction = action
            return
        case .unhandled:
            isThinking = false
        }
        let parsedAction = ChatActionParser.parse(text, sites: store.sites)
        if parsedAction == nil || parsedAction == .checkEmail {
            isThinking = true
            let emailReply = await store.handleEmailAsk(text: text)
            isThinking = false
            if let emailReply {
                store.appendChat(fromAgent: true, text: emailReply)
                return
            }
        }
        if let action = parsedAction {
            if action.requiresConfirmation {
                pendingAction = action
                return
            }
            isThinking = true
            let replyText = await store.performChatAction(action)
            isThinking = false
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

    private func prepareReply(to taskID: UUID) {
        guard let task = store.tasks.first(where: { $0.id == taskID }), task.needsChatHelp,
              let help = task.help, help.kind == .information, let question = help.questions.first else { return }
        replyTarget = TaskReplyTarget(taskID: taskID, helpID: help.id, question: question.text)
    }

    @ViewBuilder
    private func taskHelpCard(_ task: AgentTask, help: TaskHelp) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if help.kind == .information, let question = help.questions.first {
                ForEach(question.suggestions, id: \.self) { suggestion in
                    Button(suggestion) {
                        Task { await store.replyToTask(taskID: task.id, helpID: help.id,
                                                      answers: [question.text: suggestion]) }
                    }.buttonStyle(SettingsActionStyle())
                }
                if task.browserSessionID != nil {
                    Button("Do it myself") { takeBrowserControl = true; browserTask = task }
                        .buttonStyle(SettingsActionStyle(filled: false))
                }
                Button(question.suggestions.isEmpty ? "Reply" : "Something else") {
                    replyTarget = TaskReplyTarget(taskID: task.id, helpID: help.id, question: question.text)
                    composerFocused = true
                }.buttonStyle(SettingsActionStyle(filled: false))
            } else {
                Button(help.actionLabel) {
                    switch help.kind {
                    case .credentials:
                        credentialRequest = AppStore.CredentialSaveRequest(siteID: task.siteID,
                            siteName: store.siteName(id: task.siteID), domain: task.domain, taskID: task.id)
                    case .verification:
                        if task.kind == .bookCalendar {
                            Task { await store.replyToTask(taskID: task.id, helpID: help.id, choiceLabel: help.actionLabel) }
                        } else { takeBrowserControl = true; browserTask = task }
                    case .approval:
                        Task { await store.replyToTask(taskID: task.id, helpID: help.id, approved: true) }
                    case .recovery:
                        Task { await store.replyToTask(taskID: task.id, helpID: help.id, choiceLabel: help.actionLabel) }
                    case .information: break
                    }
                }.buttonStyle(SettingsActionStyle())
                if help.kind == .verification && task.kind == .bookCalendar {
                    Button("Open settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    }.buttonStyle(SettingsActionStyle(filled: false))
                }
                if help.kind == .verification && help.message.localizedCaseInsensitiveContains("email") {
                    Button("Open mail") {
                        if let url = URL(string: preferredMailApp) {
                            UIApplication.shared.open(url, options: [:]) { opened in
                                mailError = opened ? nil : "Open your email app and find the confirmation from this site."
                            }
                        }
                    }.buttonStyle(SettingsActionStyle(filled: false))
                    if let mailError { Text(mailError).font(.footnote) }
                }
            }
            Button(help.kind == .approval ? "Don't do this" : "Stop this task") {
                let label = help.kind == .approval ? "Don't do this" : "Stop this task"
                Task { await store.declineTaskHelp(taskID: task.id, helpID: help.id, choiceLabel: label) }
            }.buttonStyle(SettingsActionStyle(filled: false))
        }
        .foregroundStyle(HyggeTheme.ink)
        .padding(16).hyggeCard(radius: 20).padding(.leading, 33)
    }

    private func proposeBeliefs(from patch: EarningsProfilePatch) {
        func normalized(_ value: String) -> String {
            value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        }
        func existingItems(withPrefix prefix: String) -> Set<String> {
            Set((store.beliefs.beliefs + store.beliefs.pending)
                .filter { $0.sentence.hasPrefix(prefix) }
                .flatMap { $0.sentence.dropFirst(prefix.count).split(separator: ",").map { normalized(String($0)) } })
        }

        // Proposals are reviewed in Profile, never announced in chat.
        if let skills = patch.skills {
            let knownSkills = Set(store.profile.skills.map(normalized))
                .union(existingItems(withPrefix: "Also good at:"))
            var seenSkills = Set<String>()
            let newSkills = skills.compactMap { skill -> String? in
                let trimmed = skill.trimmingCharacters(in: .whitespacesAndNewlines)
                let key = normalized(trimmed)
                guard !trimmed.isEmpty, !knownSkills.contains(key),
                      seenSkills.insert(key).inserted else { return nil }
                return trimmed
            }
            if !newSkills.isEmpty {
                store.proposeBelief(sentence: "Also good at: \(newSkills.joined(separator: ", "))",
                                    source: .guessedFromChat, confidence: 0.7)
            }
        }
        if let availability = patch.availabilityNotes {
            let trimmedAvailability = availability.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedAvailability.isEmpty,
               normalized(trimmedAvailability) != normalized(store.profile.availabilityNotes) {
                store.proposeBelief(sentence: "Usually free: \(trimmedAvailability)",
                                    source: .youSaidIt, confidence: 0.85)
            }
        }
        if let location = patch.locationLabel {
            let trimmedLocation = location.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedLocation.isEmpty,
               normalized(trimmedLocation) != normalized(store.profile.locationLabel) {
                store.proposeBelief(sentence: "Now based in \(trimmedLocation)",
                                    source: .youSaidIt, confidence: 0.85)
            }
        }
        if let interests = patch.interests {
            let knownLabels = existingItems(withPrefix: "Also enjoys:")
            var seenInterests: [OpportunityCategory] = []
            let newInterests = interests.filter { interest in
                guard !store.profile.interests.contains(interest),
                      !knownLabels.contains(normalized(interest.activityLabel)),
                      !seenInterests.contains(interest) else { return false }
                seenInterests.append(interest)
                return true
            }
            if !newInterests.isEmpty {
                store.proposeBelief(sentence: "Also enjoys: \(newInterests.map(\.activityLabel).joined(separator: ", ").lowercased())",
                                    source: .guessedFromChat, confidence: 0.65)
            }
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
        case .pause, .resume, .explainDropped, .scanSite, .joinSite, .addSite, .checkEmail:
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
                    store.appendChat(fromAgent: false, text: "Yes, do it")
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
                    store.appendChat(fromAgent: false, text: "Not now")
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
