import SwiftUI

/// The one continuous thread with Hygge — onboarding happened here, and this
/// is the same conversation forever after. Opened by the floating flame.
struct ConversationView: View {
    /// Sheet presentations keep the paper background; the feed's speech
    /// bubble passes the card color so it lifts off the feed behind it.
    var background: Color = HyggeTheme.paper
    /// Bubbles and the composer must contrast with the surface they sit
    /// on: card on paper in a sheet, paper on card in the feed bubble.
    var bubbleBackground: Color = HyggeTheme.card
    /// The speech bubble sits right on top of him — a name header there
    /// only repeats what the flame below already says.
    var showsHeader: Bool = true
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var input = ""
    @State private var streamingText: String?
    @State private var isThinking = false
    @State private var agentState: PersistentConversationState?
    @State private var agentError: String?
    @State private var retryMessage: ChatEntry?
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
                                        // The card a message is about sits at
                                        // the BOTTOM of its bubble, in both
                                        // directions — so it is clear which
                                        // message it belongs to, with no
                                        // scrolling to the top to tap it.
                                        if let context = entry.context {
                                            contextCardRow(context, fromAgent: entry.fromAgent)
                                        }
                                        if let taskID = entry.taskID,
                                           let task = store.tasks.first(where: { $0.id == taskID }),
                                           entry.helpID != nil {
                                            if task.browserSessionID != nil,
                                               store.discussedTaskIDs.contains(task.id),
                                               store.chatTranscript.last(where: { $0.taskID == task.id })?.id == entry.id {
                                                BrowserLiveAttachment(task: task) { takeBrowserControl = false; browserTask = task }.padding(.leading, 33)
                                            }
                                            // Live status lives in the feed, never in chat:
                                            // a running task shows nothing here, and a
                                            // finished one is confirmed by a proper
                                            // message at the end of the thread, not a
                                            // caption glued to this entry.
                                            if task.needsChatHelp, let help = task.help, help.id == entry.helpID {
                                                taskHelpCard(task, help: help)
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
                                if let agentError { Text(agentError).font(.footnote).foregroundStyle(HyggeTheme.secondary) }
                                // Retry affordances stay hidden while a turn
                                // is live: after sending, the pending message
                                // is the turn in flight, not a failure.
                                if !isThinking {
                                    if let pending = agentState?.activeTurn {
                                        Button("Resume reply") { Task { await retryTurn(id: pending.id) } }
                                    } else if let retryMessage {
                                        Button("Try again") { Task { await retryTurn(id: retryMessage.id.uuidString.lowercased(), text: retryMessage.text) } }
                                    }
                                }
                                ForEach(agentState?.proposals ?? []) { proposal in
                                    agentConfirmationCard(proposal)
                                }
                                Color.clear.frame(height: 10).id("bottom")
                            }
                            .padding(.horizontal, 18).padding(.top, 22)
                        }
                        .scrollDismissesKeyboard(.interactively)
                        .onAppear {
                            store.markChatRead()
                            for task in store.chatHelpTasks { store.surfaceTaskHelp(taskID: task.id, proactive: true) }
                            // A tapped push names one message: land on it.
                            // A named message that never arrived leaves a
                            // stale id behind: drop it so a later open
                            // does not chase it again.
                            if let id = store.pendingChatMessageID,
                               store.chatTranscript.first(where: { $0.id == id }) == nil {
                                store.pendingChatMessageID = nil
                            }
                            if let id = store.pendingChatMessageID,
                               let entry = store.chatTranscript.first(where: { $0.id == id }) {
                                store.pendingChatMessageID = nil
                                proxy.scrollTo(entry.id, anchor: .top)
                            } else if let id = store.conversationTaskID,
                               let entry = store.chatTranscript.last(where: { $0.taskID == id }) {
                                proxy.scrollTo(entry.id, anchor: .top)
                            } else { proxy.scrollTo("bottom", anchor: .bottom) }
                        }
                        .onChange(of: store.pendingChatMessageID) { _, id in
                            if let id, let entry = store.chatTranscript.first(where: { $0.id == id }) {
                                store.pendingChatMessageID = nil
                                proxy.scrollTo(entry.id, anchor: .top)
                            } else if id != nil {
                                store.pendingChatMessageID = nil
                            }
                        }
                        .onChange(of: store.conversationTaskID) { _, id in
                            if let entry = store.chatTranscript.last(where: { $0.taskID == id }) {
                                proxy.scrollTo(entry.id, anchor: .top)
                            }
                        }
                        .onChange(of: store.chatTranscript.count) { _, _ in
                            store.markChatRead()
                            withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
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
                    if replyTarget == nil, let pending = store.pendingChatContext {
                        HStack(spacing: 10) {
                            chatContextCard(pending)
                            Spacer(minLength: 0)
                            Button { store.pendingChatContext = nil } label: {
                                Image(systemName: "xmark").font(.caption.weight(.semibold))
                                    .frame(width: 44, height: 44).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).foregroundStyle(HyggeTheme.secondary)
                            .accessibilityLabel("Detach card")
                        }
                        .padding(.horizontal, 14).padding(.top, 8)
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
        .task {
            await refreshConversation()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(12)) } catch { break }
                await refreshConversation()
            }
        }
    }

    private var avatarAnimation: FlameAnimation {
        if !store.chatHelpTasks.isEmpty { return .notify }
        // The laptop means a live browser run, nothing else: thinking or
        // a queued task without a session must not hold it on.
        return store.hasActiveBrowserSession ? .laptop : .walk
    }

    /// The mini-card a message is about — attached above the
    /// composer before sending, stamped below its bubble after.
    /// A card that opens its feed item carries a chevron so a
    /// live card reads as tappable; the composer copy never does.
    private func chatContextCard(_ context: ChatContextRef, showsOpenChevron: Bool = false) -> some View {
        HStack(spacing: 10) {
            if let domain = context.siteDomain {
                SiteLogoTile(domain: domain, name: context.title, size: 34)
            } else {
                Image(systemName: context.kind == "mail" ? "envelope" : context.kind == "event" ? "doc.text" : "bubble.left")
                    .font(.subheadline).foregroundStyle(HyggeTheme.sageDeep)
                    .frame(width: 34, height: 34)
                    .background(HyggeTheme.sageTint, in: RoundedRectangle(cornerRadius: 9))
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(context.title).font(.subheadline.weight(.semibold))
                    .foregroundStyle(HyggeTheme.ink).lineLimit(2)
                if !context.subtitle.isEmpty {
                    Text(context.subtitle).font(.caption).foregroundStyle(HyggeTheme.secondary).lineLimit(2)
                }
            }
            if showsOpenChevron {
                Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                    .foregroundStyle(HyggeTheme.secondary).accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .background(bubbleBackground, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(HyggeTheme.hairline, lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("About: \(context.title)")
    }

    /// A message's card, below its bubble: trailing-aligned for the
    /// user (as the bubble is), under the bubble text for Hygge.
    /// A card whose feed element still exists is a button into the
    /// feed; anything unresolvable renders untappable — and muted,
    /// so a live card reads as live. The user row has no avatar
    /// slot, so the card takes the avatar's 37pt (30pt avatar +
    /// 7pt spacing) as trailing padding to line up with the
    /// bubble's text.
    @ViewBuilder
    private func contextCardRow(_ context: ChatContextRef, fromAgent: Bool) -> some View {
        if fromAgent {
            HStack(spacing: 0) {
                contextCard(context).padding(.leading, 33)
                Spacer(minLength: 36)
            }
        } else {
            HStack(spacing: 0) {
                Spacer(minLength: 44)
                contextCard(context).padding(.trailing, 37)
            }
        }
    }

    @ViewBuilder
    private func contextCard(_ context: ChatContextRef) -> some View {
        if isExpiredTaskContext(context) {
            // Expired decision: still viewable and marked, but no
            // longer actionable — no button into the feed.
            expiredContextCard(context)
        } else if isResolvableContext(context) {
            Button { openContextInFeed(context) } label: { chatContextCard(context, showsOpenChevron: true) }
                .buttonStyle(.plain)
                .accessibilityHint("Opens in the feed")
        } else {
            chatContextCard(context).opacity(0.55)
        }
    }

    /// A context about a task whose display-only expiry has passed:
    /// the card stays visible but its action is gone.
    private func isExpiredTaskContext(_ context: ChatContextRef) -> Bool {
        guard context.kind == "task", let id = UUID(uuidString: context.id),
              let task = store.tasks.first(where: { $0.id == id }) else { return false }
        return task.help?.isExpired == true
    }

    private func expiredContextCard(_ context: ChatContextRef) -> some View {
        var expired = context
        expired.subtitle = "Expired" + (context.subtitle.isEmpty ? "" : " · \(context.subtitle)")
        return chatContextCard(expired)
            .accessibilityLabel("Expired: \(context.title)")
    }

    private func isResolvableContext(_ context: ChatContextRef) -> Bool {
        // A site context carries a site id, not a UUID-typed row id:
        // resolve it against the proposals by site, not by row.
        if context.kind == "site" { return store.proposals.contains(where: { $0.siteID == context.id }) }
        // The notifications primer has no row id either: its card
        // opens the notifications surface (see openContextInFeed).
        if context.kind == "notifications" { return true }
        guard let id = UUID(uuidString: context.id) else { return false }
        switch context.kind {
        case "opportunity": return store.opportunities.contains(where: { $0.id == id })
        case "task": return store.tasks.contains(where: { $0.id == id })
        case "mail": return store.filedEmailSummaries.contains(where: { $0.id.lowercased() == id.uuidString.lowercased() })
        case "event": return store.activityEvents.contains(where: { $0.id == id })
        default: return false
        }
    }

    /// Sets the feed-open flag and lets HomeFeedView close this chat
    /// before opening the card — then dismisses this view too, so a
    /// chat hosted by the filed-mail detail sheet does not strand
    /// the focus behind two still-open sheets. `dismiss` closes
    /// whichever sheet presented this ConversationView (the mail
    /// detail's sheet, or the conversation sheet itself) and is a
    /// no-op in the floating bubble, where Home's own dismissal
    /// covers it; the flag is still what tells Home which card
    /// to open once the sheet is gone.
    private func openContextInFeed(_ context: ChatContextRef) {
        switch context.kind {
        case "opportunity":
            guard let id = UUID(uuidString: context.id),
                  store.opportunities.contains(where: { $0.id == id }) else { return missingContext() }
            store.pendingOpportunityOpenID = id
        case "task":
            guard let id = UUID(uuidString: context.id),
                  store.tasks.contains(where: { $0.id == id }) else { return missingContext() }
            store.pendingTaskFocusOpenID = id
        case "mail":
            guard let id = UUID(uuidString: context.id),
                  store.filedEmailSummaries.contains(where: { $0.id.lowercased() == id.uuidString.lowercased() }) else { return missingContext() }
            store.pendingEmailOpenID = id
        case "site":
            guard let proposal = store.proposals.first(where: { $0.siteID == context.id }) else { return missingContext() }
            store.pendingProposalOpenID = proposal.id
        case "event":
            guard let id = UUID(uuidString: context.id),
                  store.activityEvents.contains(where: { $0.id == id }) else { return missingContext() }
            store.pendingEventOpenID = id
        case "notifications":
            store.pendingNotificationsOpen = true
        default: return
        }
        dismiss()
    }

    /// The card's feed item vanished between render and tap: close
    /// the chat so Home can say so in one line. The note is a
    /// routing fallback, so Home scrolls to the top and closes the
    /// chat bubble first — in the bubble host dismiss() is a no-op
    /// and the open bubble would otherwise cover the note.
    private func missingContext() {
        store.setRoutingNote("That one is already sorted. Everything waiting for you is below.")
        dismiss()
    }

    private var composer: some View {
        HStack(spacing: 9) {
            TextField(replyTarget == nil ? "Message Hygge…" : "Your reply…", text: $input, axis: .vertical)
                .focused($composerFocused)
                .lineLimit(1...4)
                .padding(.horizontal, 16).padding(.vertical, 12)
                .background(bubbleBackground, in: Capsule())
                .overlay(Capsule().stroke(HyggeTheme.hairline, lineWidth: 1).allowsHitTesting(false))
                .onSubmit { Task { await send() } }
            Button { Task { await send() } } label: {
                Image(systemName: "paperplane.fill")
                    .font(.system(size: 16, weight: .semibold)).foregroundStyle(.white)
                    .frame(width: 44, height: 44)
                    .background(HyggeTheme.sageDeep, in: Circle())
            }
            .accessibilityLabel("Send message")
            .disabled(input.trimmingCharacters(in: .whitespaces).isEmpty || isThinking || agentState?.activeTurn != nil || retryMessage != nil)
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
            AgentMarkdownText(text: text)
                .padding(.horizontal, 15).padding(.vertical, 12)
                .background(bubbleBackground, in: UnevenRoundedRectangle(
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
        guard !isThinking, agentState?.activeTurn == nil, retryMessage == nil else { return }
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
        // The attached card (if any) is stamped on this message
        // and consumed: the next message starts unattached.
        let attached = store.pendingChatContext
        store.pendingChatContext = nil
        store.appendConversationMessage(fromAgent: false, text: text, context: attached)
        let message = store.chatTranscript.last!
        retryMessage = message
        store.saveConversationOutbox(messageID: message.id, generation: agentState?.generation)
        await retryTurn(id: message.id.uuidString.lowercased(), text: text)
    }

    private func refreshConversation() async {
        guard !isThinking else { return }
        do {
            let state = try await store.backend.conversationState()
            agentState = state; agentError = nil
            // A new generation means the thread was cleared (reset):
            // note it before the pull, so the pull's synthesis does
            // not regrow the decision entries cleared with it.
            store.noteConversationGeneration(state.generation)
            _ = await store.pullFromServer(reconcilingConversation: state.activeTurn == nil && store.pendingConversationMessageID == nil)
            if let id = store.pendingConversationMessageID,
               let message = store.chatTranscript.first(where: { $0.id == id }) {
                if let old = store.pendingConversationGeneration, old != state.generation {
                    input = message.text; retryMessage = nil
                    store.chatTranscript.removeAll { $0.id == message.id }
                    store.saveConversationOutbox(messageID: nil)
                    _ = await store.pullFromServer(reconcilingConversation: true)
                    agentError = "The conversation was cleared on another device. Your unsent message is in the composer."
                } else { retryMessage = message }
            }
        }
        catch { agentError = "I couldn't load your saved conversation. I'll keep trying." }
    }

    private func applyConversation(_ state: PersistentConversationState) async {
        // Clear the streaming bubble before appending the final reply, so
        // the same text never shows twice (streaming bubble + entry).
        streamingText = nil
        agentState = state
        if let reply = state.reply, !reply.isEmpty {
            store.appendConversationMessage(fromAgent: true, text: reply, id: state.replyMessageId ?? UUID())
        }
        retryMessage = nil
        if await store.pullFromServer(reconcilingConversation: true) { store.saveConversationOutbox(messageID: nil) }
    }

    private func retryTurn(id: String, text: String? = nil) async {
        guard !isThinking else { return }
        // Leave streamingText nil until the first delta arrives: the
        // pre-reply phase shows nothing, not an empty bubble.
        isThinking = true; agentError = nil
        defer { isThinking = false; streamingText = nil }
        do {
            if agentState == nil { agentState = try await store.backend.conversationState() }
            guard let generation = agentState?.generation else { return }
            if let saved = store.pendingConversationGeneration, saved != generation {
                agentError = "The conversation was cleared. Refresh it to recover your unsent message."
                return
            }
            if let id = UUID(uuidString: id), retryMessage != nil { store.saveConversationOutbox(messageID: id, generation: generation) }
            await store.beginConversationRequest()
            let result = try await store.backend.conversationTurn(id: id, generation: generation, text: text,
                focus: retryMessage?.context.map { PersistentChatFocus(kind: $0.kind, id: $0.id) }) { delta in
                streamingText = (streamingText ?? "") + delta
            }
            await applyConversation(result)
        } catch {
            agentError = "That reply didn't come through. Your message is saved — the buttons below resume it."
            agentState = try? await store.backend.conversationState()
        }
    }

    private func decide(_ proposal: PersistentChatProposal, approve: Bool) async {
        guard !isThinking, let state = agentState else { return }
        isThinking = true; agentError = nil
        defer { isThinking = false }
        do {
            await store.beginConversationRequest()
            let result = try await store.backend.conversationDecision(generation: state.generation, proposalID: proposal.id, approve: approve)
            await applyConversation(result)
            if approve, let device = result.proposals.first(where: { $0.id == proposal.id && $0.result?.status == "device_required" }) {
                await finishDeviceAction(device, generation: state.generation)
            }
        } catch {
            agentError = "That decision didn't go through. The card below is still waiting."
            agentState = try? await store.backend.conversationState()
        }
    }

    private func finishDeviceAction(_ proposal: PersistentChatProposal, generation: String) async {
        guard let payload = proposal.result?.payload else { return }
        await store.beginConversationRequest()
        do { try await store.backend.claimConversationDeviceAction(generation: generation, proposalID: proposal.id) }
        catch { agentError = "This calendar action may already be in progress on another device."; return }
        let success = await CalendarService.book(payload: payload, operationID: proposal.id)
        do { await applyConversation(try await store.backend.conversationDeviceResult(generation: generation, proposalID: proposal.id, success: success)) }
        catch { agentError = success ? "It's in your calendar. I couldn't confirm the result here." : "That booking didn't go through." }
    }

    @ViewBuilder
    private func taskHelpCard(_ task: AgentTask, help: TaskHelp) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            // Display-only expiry: a lapsed deadline renders as
            // "Expired" and the card's actions go dead — it stays
            // visible, but nothing here acts on the task anymore.
            if let deadline = help.deadline, let date = TaskHelp.expiryDate(deadline) {
                Text(help.isExpired ? "Expired" : "Expires \(date.formatted(date: .abbreviated, time: .shortened))")
                    .font(.caption).foregroundStyle(HyggeTheme.secondary)
            }
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
                // A pending effect is not a review: the agent verifies
                // the step itself and resumes on its own, so a task
                // with a pending effect and a real request shows the
                // request's own action here.
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
        .disabled(help.isExpired)
        .foregroundStyle(HyggeTheme.ink)
        .padding(16).hyggeCard(radius: 20).padding(.leading, 33)
    }

    private func agentConfirmationCard(_ proposal: PersistentChatProposal) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(proposal.title).font(.subheadline.weight(.semibold)).foregroundStyle(HyggeTheme.ink)
            ForEach((proposal.details ?? [:]).keys.sorted(), id: \.self) { key in
                Text("\(key): \(proposal.details?[key] ?? "")").font(.footnote).foregroundStyle(HyggeTheme.secondary)
            }
            if proposal.status == "pending" {
                HStack {
                    Button("Yes, do it") { Task { await decide(proposal, approve: true) } }
                        .buttonStyle(SettingsActionStyle())
                    Button("Not now") { Task { await decide(proposal, approve: false) } }
                        .buttonStyle(SettingsActionStyle(filled: false))
                }
            } else if proposal.result?.status == "device_required", let generation = agentState?.generation {
                Button("Add to calendar") {
                    Task {
                        isThinking = true
                        await finishDeviceAction(proposal, generation: generation)
                        isThinking = false
                    }
                }.buttonStyle(SettingsActionStyle())
            } else {
                Text("This action needs its outcome checked before it can continue.")
                    .font(.footnote).foregroundStyle(HyggeTheme.secondary)
            }
        }
        .disabled(isThinking)
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
