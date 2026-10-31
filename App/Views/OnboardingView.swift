import SwiftUI

// MARK: - Design tokens

/// Legacy onboarding token names, now all appearance-aware via HyggeTheme.
private enum GPTheme {
    static var paper: Color { HyggeTheme.paper }
    static var ink: Color { HyggeTheme.ink }
    static var teal: Color { HyggeTheme.sageDeep }
    static var amber: Color { HyggeTheme.emberDeep }
    static var card: Color { HyggeTheme.card }
    static var hairline: Color { HyggeTheme.hairline }
    static var secondary: Color { HyggeTheme.secondary }
}

// MARK: - Feed model

private struct FeedEntry: Identifiable {
    enum Kind { case agent, user, thinking, input }
    let id = UUID()
    var kind: Kind
    var text = ""
    var step: OnboardingStep?
}

/// Onboarding is one conversation feed. Agent replies stream in token by
/// token; the input for a step appears IN the feed only after its agent
/// message has finished. There is deliberately no fixed footer composer.
struct OnboardingView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var conversation = OnboardingConversation()
    @State private var entries: [FeedEntry] = []
    @State private var input = ""
    @State private var availabilityInput = ""
    @State private var locationService = LocationService()
    @State private var calendarGranted: Bool?
    @State private var notificationsGranted: Bool?
    @State private var showBackendSettings = false
    @State private var serviceOnline: Bool?
    @State private var streamingEntryID: UUID?
    @State private var started = false

    var body: some View {
        NavigationStack {
            ZStack {
                GPTheme.paper.ignoresSafeArea()
                if conversation.step == .welcome {
                    welcomeHero
                } else {
                    VStack(spacing: 0) {
                        header
                        feed
                    }
                }
            }
            #if DEBUG
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showBackendSettings = true } label: {
                        Image(systemName: "server.rack").foregroundStyle(GPTheme.ink)
                    }
                }
            }
            .sheet(isPresented: $showBackendSettings, onDismiss: { Task { await checkService() } }) {
                BackendSettingsView()
            }
            #endif
            .onAppear {
                Task { await checkService() }
                if !started {
                    started = true
                    Task { await agentTurn() }
                }
            }
        }
    }

    private var welcomeHero: some View {
        VStack(spacing: 0) {
            Spacer()
            FlameMark(size: 150)
            Text("Hi, I'm Hygge,")
                .font(.system(size: 36, weight: .bold, design: .rounded))
                .foregroundStyle(GPTheme.ink)
                .padding(.top, 26)
            Text("hoo-gah").font(.headline).foregroundStyle(GPTheme.amber).padding(.top, 6)
            Text("I find work you like and handle\nthe boring parts.")
                .font(.body).foregroundStyle(GPTheme.ink)
                .multilineTextAlignment(.center).lineSpacing(3)
                .padding(.top, 14)
            Spacer()
            Button {
                submitUser("Ready", value: "")
            } label: {
                Text("Get started")
                    .font(.body.weight(.semibold))
                    .frame(maxWidth: .infinity).padding(.vertical, 17)
                    .background(GPTheme.amber, in: Capsule()).foregroundStyle(.white)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 22).padding(.bottom, 14)
        }
    }

    private var header: some View {
        HStack(alignment: .center) {
            if conversation.canGoBack {
                Button { goBackOneQuestion() } label: {
                    HStack(spacing: 3) {
                        Image(systemName: "chevron.backward").font(.system(size: 14, weight: .semibold))
                        Text("Back").font(.body)
                    }
                    .foregroundStyle(GPTheme.amber)
                }
                .accessibilityLabel("Back one question")
            }
            Spacer()
            if serviceOnline == false {
                Text("Offline — simple mode").font(.caption).foregroundStyle(GPTheme.secondary)
            }
            Spacer()
            if let q = questionNumber {
                Text("\(q) of 3").font(.body).foregroundStyle(GPTheme.secondary)
            }
        }
        .padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 10)
    }

    private var progress: Double {
        let all = OnboardingStep.allCases
        guard let i = all.firstIndex(of: conversation.step) else { return 0 }
        return Double(i) / Double(all.count - 1)
    }

    private var feed: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {

                    ForEach(entries) { entry in
                        entryView(entry)
                            .id(entry.id)
                            .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
                    }
                    Color.clear.frame(height: 28)
                }
                .padding(.horizontal, 20).padding(.top, 6)
                .animation(reduceMotion ? nil : .spring(response: 0.45, dampingFraction: 0.88), value: entries.count)
                .animation(reduceMotion ? nil : .spring(response: 0.45, dampingFraction: 0.88), value: conversation.step)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: entries.count) { _, _ in scrollToBottom(proxy) }
            .onChange(of: streamingTextLength) { _, _ in scrollToBottom(proxy) }
        }
    }

    private var streamingTextLength: Int { entries.last(where: { $0.kind == .agent })?.text.count ?? 0 }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        guard let last = entries.last else { return }
        if reduceMotion {
            proxy.scrollTo(last.id, anchor: .bottom)
        } else {
            withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(last.id, anchor: .bottom) }
        }
    }

    private var questionNumber: Int? { conversation.questionNumber }

    private var intro: some View {
        VStack(alignment: .center, spacing: 8) {
            FlameMark(size: 96).padding(.top, 18)
            Text("Hi, I'm Hygge,")
                .font(.system(.largeTitle, design: .rounded, weight: .bold))
                .foregroundStyle(GPTheme.ink)
            Text("hoo-gah").font(.headline).foregroundStyle(GPTheme.amber)
            Text("I find work you like and handle\nthe boring parts.")
                .font(.body).foregroundStyle(GPTheme.ink).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.bottom, 6)
    }

    // MARK: - Feed entries

    @ViewBuilder
    private func entryView(_ entry: FeedEntry) -> some View {
        switch entry.kind {
        case .agent:
            HStack(alignment: .top, spacing: 9) {
                avatar
                VStack(alignment: .leading, spacing: 3) {
                Text("Hygge").font(.caption).foregroundStyle(GPTheme.amber)
                Text(entry.text.isEmpty ? " " : entry.text)
                    .font(.body)
                    .foregroundStyle(GPTheme.ink)
                    .lineSpacing(3)
                    .padding(.horizontal, 15).padding(.vertical, 12)
                    .background(GPTheme.card, in: UnevenRoundedRectangle(
                        topLeadingRadius: 6, bottomLeadingRadius: 20,
                        bottomTrailingRadius: 20, topTrailingRadius: 20))
                    .overlay(UnevenRoundedRectangle(
                        topLeadingRadius: 6, bottomLeadingRadius: 20,
                        bottomTrailingRadius: 20, topTrailingRadius: 20)
                        .stroke(GPTheme.hairline, lineWidth: 1))
                    .shadow(color: GPTheme.ink.opacity(0.05), radius: 10, y: 3)
                }
                Spacer(minLength: 36)
            }
        case .user:
            HStack {
                Spacer(minLength: 52)
                Text(entry.text)
                    .font(.body)
                    .foregroundStyle(.white)
                    .lineSpacing(3)
                    .padding(.horizontal, 15).padding(.vertical, 12)
                    .background(GPTheme.teal, in: UnevenRoundedRectangle(
                        topLeadingRadius: 20, bottomLeadingRadius: 20,
                        bottomTrailingRadius: 6, topTrailingRadius: 20))
            }
        case .thinking:
            HStack(alignment: .center, spacing: 9) {
                avatar
                ThinkingDots()
                    .padding(.horizontal, 15).padding(.vertical, 14)
                    .background(GPTheme.card, in: UnevenRoundedRectangle(
                        topLeadingRadius: 6, bottomLeadingRadius: 20,
                        bottomTrailingRadius: 20, topTrailingRadius: 20))
                    .overlay(UnevenRoundedRectangle(
                        topLeadingRadius: 6, bottomLeadingRadius: 20,
                        bottomTrailingRadius: 20, topTrailingRadius: 20)
                        .stroke(GPTheme.hairline, lineWidth: 1))
                Text("Thinking…").font(.caption).foregroundStyle(GPTheme.secondary)
                Spacer()
            }
            .accessibilityLabel("Hygge is thinking")
        case .input:
            inputCard(step: entry.step ?? conversation.step)
                .padding(.leading, 39)
        }
    }

    private var avatar: some View { FlameMark(size: 24).padding(.top, 2) }

    // MARK: - Input cards (in-feed, appear only after their agent message)

    @ViewBuilder
    private func inputCard(step: OnboardingStep) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            switch step {
            case .welcome:
                primaryButton("Get started", icon: "arrow.right") { submitUser("Ready", value: "") }
            case .enjoyWork:
                if !conversation.suggestedCategories.isEmpty {
                    Label("Picked for you from what you've said", systemImage: "wand.and.rays")
                        .font(.caption.weight(.medium)).foregroundStyle(GPTheme.amber)
                }
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                    ForEach(categoryOptions, id: \.activityLabel) { category in
                        enjoyTile(category)
                    }
                }
                if !conversation.suggestedSkills.isEmpty {
                    Text("Sounds like these fit too — tap to keep:").font(.caption).foregroundStyle(GPTheme.secondary)
                    FlowLayout(spacing: 7) {
                        ForEach(skillOptions, id: \.self) { skill in
                            chip(skill, selected: conversation.profile.skills.contains(skill)) { conversation.toggleSkill(skill) }
                        }
                    }
                }
                textRow(placeholder: "Type another preference...")
                primaryButton("Continue") {
                    guard conversation.confirmEnjoyWork() else { return }
                    finishInput(userText: conversation.profile.interests.map(\.label).joined(separator: ", "))
                }
                .disabled(conversation.profile.interests.isEmpty)
                .opacity(conversation.profile.interests.isEmpty ? 0.45 : 1)
            case .lowestRate:
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text("$\(Int(conversation.profile.hourlyRateFloor))")
                        .font(.system(.title, design: .rounded, weight: .bold)).foregroundStyle(GPTheme.ink)
                    Text("/ hour minimum").font(.subheadline).foregroundStyle(GPTheme.secondary)
                }
                Slider(value: Binding(get: { conversation.profile.hourlyRateFloor },
                                      set: { conversation.profile.hourlyRateFloor = $0 }),
                       in: 10...120, step: 1)
                    .tint(GPTheme.teal)
                primaryButton("Continue") {
                    finishInput(userText: "At least $\(Int(conversation.profile.hourlyRateFloor))/hr", mutate: { $0.advance() })
                }
            case .whereWhen:
                textRow(placeholder: "Town or city")
                Button {
                    Task {
                        if let label = await locationService.requestLocality() {
                            conversation.profile.availabilityNotes = availabilityInput
                            submitUser(label, value: label)
                        }
                    }
                } label: {
                    Label("Use my current location", systemImage: "location.fill")
                        .font(.subheadline.weight(.medium)).foregroundStyle(GPTheme.teal)
                }
                TextField("When are you free? e.g. Weekends, 10am-2pm", text: $availabilityInput)
                    .textFieldStyle(.plain).font(.body)
                    .padding(.horizontal, 13).padding(.vertical, 11)
                    .background(GPTheme.paper, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(GPTheme.hairline, lineWidth: 1))
                permissionRow(icon: "calendar", title: "Calendar",
                              why: "So I never double-book you, and approved gigs land in your calendar.",
                              granted: calendarGranted) {
                    Task { calendarGranted = await PermissionService.requestCalendar() }
                }
                primaryButton("Continue") {
                    conversation.profile.availabilityNotes = availabilityInput
                    let place = input.isEmpty ? conversation.profile.locationLabel : input
                    submitUser(place + (availabilityInput.isEmpty ? "" : " · " + availabilityInput), value: place)
                    input = ""
                }
            case .summary:
                summaryCard
            case .done:
                EmptyView()
            }
        }
        .padding(16)
        .background(GPTheme.card, in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(GPTheme.hairline, lineWidth: 1))
        .shadow(color: GPTheme.ink.opacity(0.06), radius: 14, y: 5)
    }

    @State private var nameDraft = ""

    private var summaryCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            // The identity moment: one contextual question, asked when the
            // name is actually about to be used on profiles — not upfront.
            if conversation.profile.displayName.trimmingCharacters(in: .whitespaces).isEmpty {
                Text("One last thing — what name should I use for you on profiles?")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(GPTheme.ink)
                HStack(spacing: 9) {
                    TextField("Your name", text: $nameDraft)
                        .textFieldStyle(.plain).font(.body)
                        .padding(.horizontal, 13).padding(.vertical, 11)
                        .background(GPTheme.paper, in: RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(GPTheme.hairline, lineWidth: 1))
                        .textInputAutocapitalization(.words)
                    Button("Save name") {
                        conversation.profile.displayName = nameDraft.trimmingCharacters(in: .whitespaces)
                    }
                    .font(.subheadline.weight(.semibold)).foregroundStyle(GPTheme.teal)
                    .disabled(nameDraft.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            Text(conversation.profile.headline.isEmpty ? conversation.profile.displayName : conversation.profile.headline)
                .font(.system(.title3, design: .serif, weight: .semibold)).foregroundStyle(GPTheme.ink)
            summaryRow("briefcase", conversation.profile.interests.map(\.label).joined(separator: " · "))
            summaryRow("wrench.and.screwdriver", conversation.profile.skills.joined(separator: ", "))
            summaryRow("mappin.and.ellipse", "\(conversation.profile.locationLabel) — from $\(Int(conversation.profile.hourlyRateFloor))/hr")
            if !conversation.profile.availabilityNotes.isEmpty {
                summaryRow("clock", conversation.profile.availabilityNotes)
            }
            summaryRow("envelope", conversation.profile.email)
            primaryButton("Looks good — suggest sites for me", icon: "arrow.right") {
                let profile = conversation.profile
                removeInputs()
                store.completeOnboarding(profile: profile)
                Task { await store.refreshProposalsFromBackend() }
            }
            .disabled(!conversation.profile.isComplete)
            .opacity(conversation.profile.isComplete ? 1 : 0.45)
        }
    }

    private func summaryRow(_ icon: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: icon).font(.caption).foregroundStyle(GPTheme.teal).frame(width: 16)
            Text(text).font(.subheadline).foregroundStyle(GPTheme.ink)
        }
    }

    private func permissionRow(icon: String, title: String, why: String, granted: Bool?,
                               action: @escaping () -> Void) -> some View {
        HStack(spacing: 11) {
            ZStack {
                RoundedRectangle(cornerRadius: 9).fill(GPTheme.teal.opacity(0.12)).frame(width: 34, height: 34)
                Image(systemName: icon).font(.system(size: 14)).foregroundStyle(GPTheme.teal)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(GPTheme.ink)
                Text(why).font(.caption).foregroundStyle(GPTheme.secondary)
            }
            Spacer()
            if let granted {
                Label(granted ? "On" : "Off", systemImage: granted ? "checkmark.circle.fill" : "circle")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(granted ? GPTheme.teal : GPTheme.secondary)
                    .labelStyle(.iconOnly)
            } else {
                Button("Allow") { action() }
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.bordered).tint(GPTheme.teal).controlSize(.small)
            }
        }
    }

    private func chip(_ label: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if selected { Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)) }
                Text(label).font(.subheadline.weight(selected ? .semibold : .regular))
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(selected ? GPTheme.teal : GPTheme.paper, in: Capsule())
            .overlay(Capsule().stroke(selected ? GPTheme.teal : GPTheme.ink.opacity(0.14), lineWidth: 1))
            .foregroundStyle(selected ? .white : GPTheme.ink)
        }
        .buttonStyle(.plain)
    }

    private func textRow(placeholder: String) -> some View {
        HStack(spacing: 9) {
            TextField(placeholder, text: $input)
                .textFieldStyle(.plain)
                .font(.body)
                .padding(.horizontal, 17).padding(.vertical, 13)
                .background(GPTheme.card, in: Capsule())
                .overlay(Capsule().stroke(GPTheme.hairline, lineWidth: 1))
                .autocorrectionDisabled(false)
                .textInputAutocapitalization(.sentences)
                .onSubmit { submitUser(input, value: input); input = "" }
            Button {
                let value = input
                submitUser(value, value: value)
                input = ""
            } label: {
                Image(systemName: "paperplane.fill")
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                    .frame(width: 42, height: 42)
                    .background(GPTheme.amber, in: Circle())
            }
            .disabled(input.trimmingCharacters(in: .whitespaces).isEmpty && conversation.profile.skills.isEmpty)
        }
    }

    private func primaryButton(_ title: String, icon: String? = nil,
                               action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Text(title).font(.subheadline.weight(.semibold))
                if let icon { Image(systemName: icon).font(.system(size: 12, weight: .semibold)) }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
            .background(GPTheme.amber, in: RoundedRectangle(cornerRadius: 13))
            .foregroundStyle(.white)
        }
        .buttonStyle(.plain)
    }

    private func placeholder(for step: OnboardingStep) -> String {
        switch step {
        case .enjoyWork: return "Type another preference..."
        case .whereWhen: return "Town or city"
        default: return "Type here"
        }
    }

    private var categoryOptions: [OpportunityCategory] {
        let ordered = conversation.suggestedCategories
            + OpportunityCategory.allCases.filter { !conversation.suggestedCategories.contains($0) }
        var capped = Array(ordered.prefix(6))
        for selected in conversation.profile.interests where !capped.contains(selected) {
            capped.append(selected)
        }
        return capped
    }

    private var skillOptions: [String] {
        let ordered = conversation.suggestedSkills + SkillPresets.all.filter { !conversation.suggestedSkills.contains($0) }
        var capped = Array(ordered.prefix(8))
        for selected in conversation.profile.skills where !capped.contains(selected) {
            capped.append(selected)
        }
        return capped
    }

    private func enjoyTile(_ category: OpportunityCategory) -> some View {
        let selected = conversation.profile.interests.contains(category)
        return Button { conversation.toggleCategory(category) } label: {
            HStack(spacing: 10) {
                Image(systemName: categoryIcon(category))
                    .font(.system(size: 20))
                    .foregroundStyle(selected ? GPTheme.amber : GPTheme.teal)
                Text(category.activityLabel)
                    .font(.body.weight(selected ? .semibold : .regular))
                    .foregroundStyle(selected ? GPTheme.amber : GPTheme.ink)
                    .lineLimit(2).minimumScaleFactor(0.85)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
            .padding(.horizontal, 15).padding(.vertical, 12)
            .background(selected ? HyggeTheme.peach : GPTheme.card,
                        in: RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20)
                .stroke(selected ? GPTheme.amber : GPTheme.hairline, lineWidth: selected ? 1.6 : 1))
        }
        .buttonStyle(.plain)
    }

    private func categoryIcon(_ category: OpportunityCategory) -> String {
        switch category {
        case .petCare: return "pawprint.fill"
        case .freelance: return "laptopcomputer"
        case .localGig: return "mappin.and.ellipse"
        case .delivery: return "car.fill"
        case .creative: return "paintpalette.fill"
        case .tutoring: return "book.fill"
        case .homeServices: return "leaf.fill"
        case .remoteJob: return "wifi"
        case .community: return "person.3.fill"
        }
    }

    // MARK: - Conversation engine

    private func removeInputs() {
        entries.removeAll { $0.kind == .input }
    }

    /// Step back one question. History stays visible (it really happened);
    /// Hygge simply asks again and the new answer wins.
    private func goBackOneQuestion() {
        guard conversation.canGoBack else { return }
        removeInputs()
        conversation.goBack()
        entries.append(FeedEntry(kind: .agent, text: "No problem — let's redo that one. Your new answer replaces the old."))
        Task { await agentTurn() }
    }

    /// Text-path submission: local script extraction first, then a generated turn.
    private func submitUser(_ displayText: String, value: String) {
        removeInputs()
        if !displayText.trimmingCharacters(in: .whitespaces).isEmpty {
            entries.append(FeedEntry(kind: .user, text: displayText))
            store.appendChat(fromAgent: false, text: displayText)
        }
        if conversation.submitText(value) {
            Task { await agentTurn() }
        } else {
            entries.append(FeedEntry(kind: .agent, text: "I need a bit more there before we continue."))
            appendInputCard()
        }
    }

    /// Button-path submission where the mutation already happened in the card.
    private func finishInput(userText: String, mutate: ((inout OnboardingConversation) -> Void)? = nil) {
        removeInputs()
        entries.append(FeedEntry(kind: .user, text: userText))
        store.appendChat(fromAgent: false, text: userText)
        if var mutate { mutate(&conversation) }
        Task { await agentTurn() }
    }

    private func appendInputCard() {
        guard conversation.step != .done else { return }
        removeInputs()
        withAnimation(reduceMotion ? nil : .spring(response: 0.45, dampingFraction: 0.88)) {
            entries.append(FeedEntry(kind: .input, step: conversation.step))
        }
    }

    /// One generated agent turn, streamed. Thinking dots show until the first
    /// token arrives; the input card appears only after the reply completes.
    private func agentTurn() async {
        guard conversation.step != .done else { return }
        let thinking = FeedEntry(kind: .thinking)
        entries.append(thinking)
        let transcript = entries.compactMap { entry -> BackendClient.TranscriptLine? in
            switch entry.kind {
            case .agent: return .init(fromAgent: true, text: entry.text)
            case .user: return .init(fromAgent: false, text: entry.text)
            default: return nil
            }
        }
        do {
            let reply = try await store.backend.onboardingStream(
                step: conversation.step, transcript: transcript, profile: conversation.profile
            ) { delta in
                appendDelta(delta, replacing: thinking.id)
            }
            finishAgentMessage(reply, thinkingID: thinking.id)
        } catch {
            if let reply = try? await store.backend.onboardingMessage(
                step: conversation.step, transcript: transcript, profile: conversation.profile) {
                finishAgentMessage(reply, thinkingID: thinking.id)
            } else {
                serviceOnline = false
                replaceEntry(thinking.id, with: conversation.step.prompt)
                appendInputCard()
            }
        }
    }

    private func appendDelta(_ delta: String, replacing thinkingID: UUID) {
        if let id = streamingEntryID, let i = entries.firstIndex(where: { $0.id == id }) {
            entries[i].text += delta
        } else if let i = entries.firstIndex(where: { $0.id == thinkingID }) {
            entries[i] = FeedEntry(kind: .agent, text: delta)
            streamingEntryID = entries[i].id
        }
    }

    private func replaceEntry(_ id: UUID, with text: String) {
        if let i = entries.firstIndex(where: { $0.id == id }) {
            entries[i] = FeedEntry(kind: .agent, text: text)
        } else {
            entries.append(FeedEntry(kind: .agent, text: text))
        }
    }

    private func finishAgentMessage(_ reply: OnboardingAssistantReply, thinkingID: UUID) {
        serviceOnline = reply.simulated != true
        store.appendChat(fromAgent: true, text: reply.reply)
        if let id = streamingEntryID {
            replaceEntry(id, with: reply.reply)
        } else {
            replaceEntry(thinkingID, with: reply.reply)
        }
        streamingEntryID = nil
        conversation.applyAssistant(reply)
        // The asked-for input appears only once its message is fully here.
        Task {
            try? await Task.sleep(for: .milliseconds(reduceMotion ? 0 : 320))
            appendInputCard()
        }
    }

    private func checkService() async {
        if let health = try? await store.backend.testConnection() {
            serviceOnline = health.llm == "live"
        } else {
            serviceOnline = false
        }
    }
}

/// Three-dot "agent is thinking" pulse; static when Reduce Motion is on.
private struct ThinkingDots: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 0.1)) { context in
            HStack(spacing: 6) {
                ForEach(0..<3, id: \.self) { index in
                    let phase = reduceMotion ? 0.5
                        : 0.5 + 0.5 * sin(context.date.timeIntervalSinceReferenceDate * 3.2 - Double(index) * 0.55)
                    Circle()
                        .fill(GPTheme.teal.opacity(0.35 + 0.65 * phase))
                        .frame(width: 8, height: 8)
                        .scaleEffect(0.75 + 0.35 * phase)
                        .offset(y: -3 * phase)
                }
            }
        }
        .frame(width: 44, height: 14)
    }
}

/// Simple wrapping flow for chips.
private struct FlowLayout: Layout {
    var spacing: CGFloat = 7

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(proposal: proposal, subviews: subviews)
        let height = rows.reduce(0) { $0 + $1.height } + spacing * Double(max(rows.count - 1, 0))
        return CGSize(width: proposal.width ?? 0, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(proposal: proposal, subviews: subviews) {
            var x = bounds.minX
            for item in row.items {
                subviews[item.index].place(at: CGPoint(x: x, y: y), anchor: .topLeading,
                                           proposal: ProposedViewSize(item.size))
                x += item.size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row { var items: [(index: Int, size: CGSize)] = []; var height: CGFloat = 0 }

    private func arrange(proposal: ProposedViewSize, subviews: Subviews) -> [Row] {
        let maxWidth = proposal.width ?? .infinity
        var rows: [Row] = [Row()]
        var x: CGFloat = 0
        for (index, subview) in subviews.enumerated() {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > maxWidth, !rows[rows.count - 1].items.isEmpty {
                rows.append(Row()); x = 0
            }
            rows[rows.count - 1].items.append((index, size))
            rows[rows.count - 1].height = max(rows[rows.count - 1].height, size.height)
            x += size.width + spacing
        }
        return rows
    }
}

#if DEBUG
/// Where the agent service lives. On a phone, point this at the Mac running
/// `LAN=1 ./run-live.sh` (it prints the token to paste here).
struct BackendSettingsView: View {
    @AppStorage("backendBaseURL") private var backendBaseURL = "http://127.0.0.1:8787"
    @AppStorage("backendToken") private var backendToken = ""
    @Environment(\.dismiss) private var dismiss
    @State private var testResult = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Agent service") {
                    TextField("Base URL", text: $backendBaseURL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    SecureField("API token (LAN mode)", text: $backendToken)
                    Text("On this phone, use your computer's Wi-Fi address, e.g. http://192.168.1.20:8787, with the token printed by run-live.sh. Without a reachable service, onboarding falls back to built-in prompts and missions run locally (simulated).")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Button("Test connection") {
                    Task {
                        do {
                            let health = try await BackendClient().testConnection()
                            testResult = "Connected. LLM: \(health.llm ?? "?"), browser: \(health.browser ?? "?"). Token accepted."
                        } catch {
                            testResult = "Could not connect: \(error.localizedDescription). Check: same Wi-Fi, server running with LAN=1, URL/token correct, and allow Hygge under iOS Settings → Privacy & Security → Local Network."
                        }
                    }
                }
                if !testResult.isEmpty { Text(testResult).font(.footnote) }
                Button("Done") { dismiss() }
            }
            .navigationTitle("Agent service")
        }
    }
}
#endif
