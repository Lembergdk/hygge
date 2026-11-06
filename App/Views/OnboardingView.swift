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
    /// Returning-user path: the same feed, showing only the sign-in
    /// message instead of the whole conversation.
    var signInOnly = false
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var conversation = OnboardingConversation()
    @State private var entries: [FeedEntry] = []
    @State private var input = ""
    @State private var locationService = LocationService()
    @State private var calendarGranted: Bool?
    @State private var notificationsGranted: Bool?
    @State private var serviceOnline: Bool?
    @State private var streamingEntryID: UUID?
    @State private var started = false
    @State private var isLocating = false

    var body: some View {
        NavigationStack {
            ZStack {
                GPTheme.paper.ignoresSafeArea()
                // The 3-screen intro is the welcome now; this view
                // is always the chat itself.
                VStack(spacing: 0) {
                    header
                    feed
                }
            }
            .onAppear {
                Task { await checkService() }
                if !started {
                    started = true
                    if signInOnly {
                        conversation.step = .signIn
                        entries.append(FeedEntry(kind: .agent, text: OnboardingStep.signIn.prompt))
                        appendInputCard()
                    } else {
                        // Straight into the first real question: the
                        // intro carousel already did the welcoming.
                        if conversation.step == .welcome { conversation.step = .enjoyWork }
                        Task { await firstTurn() }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var header: some View {
        if serviceOnline == false {
            HStack {
                Text("Offline — simple mode").font(.caption).foregroundStyle(GPTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
            }
            .padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 10)
        }
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
                    // Stable bottom target: entry identities change
                    // as thinking/streaming entries are replaced, so
                    // scrolling aims here instead.
                    Color.clear.frame(height: 1).id(Self.bottomSentinel)
                }
                .padding(.horizontal, 20).padding(.top, 6)
                .animation(reduceMotion ? nil : .spring(response: 0.45, dampingFraction: 0.88), value: entries.count)
                .animation(reduceMotion ? nil : .spring(response: 0.45, dampingFraction: 0.88), value: conversation.step)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: entries.count) { _, _ in scrollToBottom(proxy) }
            .onChange(of: streamingTextLength) { _, _ in scrollToBottom(proxy) }
            .onChange(of: conversation.step) { _, _ in scrollToBottom(proxy) }
        }
    }

    private var streamingTextLength: Int { entries.last(where: { $0.kind == .agent })?.text.count ?? 0 }

    private static let bottomSentinel = "feed-bottom"

    /// Scroll once now and once after layout settles: an input card
    /// appended this frame (tiles, slider, permission row) reaches
    /// its real height a beat later, and the first scroll alone
    /// used to land short of it.
    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        scrollNow(proxy)
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(380))
            scrollNow(proxy)
        }
    }

    private func scrollNow(_ proxy: ScrollViewProxy) {
        guard !entries.isEmpty else { return }
        if reduceMotion {
            proxy.scrollTo(Self.bottomSentinel, anchor: .bottom)
        } else {
            withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(Self.bottomSentinel, anchor: .bottom) }
        }
    }

    // MARK: - Feed entries

    @ViewBuilder
    private func entryView(_ entry: FeedEntry) -> some View {
        switch entry.kind {
        case .agent:
            HStack(alignment: .top, spacing: 9) {
                avatar
                VStack(alignment: .leading, spacing: 3) {
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
                    .foregroundStyle(GPTheme.ink)
                    .lineSpacing(3)
                    .padding(.horizontal, 15).padding(.vertical, 12)
                    .background(HyggeTheme.sageTint, in: UnevenRoundedRectangle(
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
                Spacer()
            }
            .accessibilityLabel("Hygge is thinking")
        case .input:
            inputCard(step: entry.step ?? conversation.step)
                .padding(.leading, 52)
        }
    }

    private var avatar: some View { FlameMark(size: 40).padding(.top, 2) }

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
                // Two columns at small sizes; one full-width column from
                // XXLarge up, so tile labels never truncate or break.
                LazyVGrid(columns: dynamicTypeSize >= .xxLarge
                          ? [GridItem(.flexible())]
                          : [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                    ForEach(categoryOptions) { category in
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
                textRow(placeholder: "Type another…")
                primaryButton("Continue") {
                    let extra = input.trimmingCharacters(in: .whitespaces)
                    if !extra.isEmpty, !conversation.profile.skills.contains(extra) {
                        conversation.profile.skills.append(extra)
                    }
                    guard conversation.confirmEnjoyWork() else { return }
                    let picked = conversation.profile.interests.map(\.label).joined(separator: ", ")
                    input = ""
                    finishInput(userText: extra.isEmpty ? picked : picked + " · " + extra)
                }
                .disabled(conversation.profile.interests.isEmpty)
                .opacity(conversation.profile.interests.isEmpty ? 0.45 : 1)
            case .lowestRate:
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text("$\(Int(conversation.profile.hourlyRateFloor))")
                        .font(.system(size: 36, weight: .bold, design: .rounded)).foregroundStyle(GPTheme.ink)
                    Text("/ hour minimum").font(.subheadline).foregroundStyle(GPTheme.secondary)
                }
                Slider(value: Binding(get: { conversation.profile.hourlyRateFloor },
                                      set: { conversation.profile.hourlyRateFloor = $0 }),
                       in: 10...300, step: 5)
                    .tint(GPTheme.teal)
                primaryButton("Continue") {
                    finishInput(userText: "At least $\(Int(conversation.profile.hourlyRateFloor))/hr", mutate: { $0.advance() })
                }
            case .where:
                locationRow
                primaryButton("Continue") {
                    let place = input.isEmpty ? conversation.profile.locationLabel : input
                    submitUser(place, value: place)
                    input = ""
                }
                .disabled(input.trimmingCharacters(in: .whitespaces).isEmpty && conversation.profile.locationLabel.isEmpty)
                .opacity(input.trimmingCharacters(in: .whitespaces).isEmpty && conversation.profile.locationLabel.isEmpty ? 0.45 : 1)
            case .when:
                // Two optional permissions, one card, separate
                // consent each — iOS prompts are per-permission,
                // and bundling them behind one Allow would blur
                // what the user said yes to. Availability itself
                // is honed later in the ongoing conversation.
                permissionsCard
            case .summary:
                summaryCard
            case .signIn:
                SignInCard(localProfile: signInOnly ? nil : conversation.profile) {
                    // Signed in mid-onboarding: proposals can refresh
                    // now that the account exists. Routing itself
                    // follows the store (Home or more questions).
                    if !signInOnly { Task { await store.refreshProposalsFromBackend() } }
                }
            case .done:
                EmptyView()
            }
        }
        .padding(20)
        .background(GPTheme.card, in: RoundedRectangle(cornerRadius: 26))
        .overlay(RoundedRectangle(cornerRadius: 26).stroke(GPTheme.hairline, lineWidth: 1))
        .shadow(color: GPTheme.ink.opacity(0.06), radius: 14, y: 5)
    }

    private var summaryCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            // No name ask: the name arrives with account signup later.
            if !conversation.profile.headline.isEmpty {
                Text(conversation.profile.headline)
                    .font(.system(.title3, design: .serif, weight: .semibold)).foregroundStyle(GPTheme.ink)
            }
            summaryRow("briefcase", conversation.profile.interests.map(\.label).joined(separator: " · "))
            if !conversation.profile.skills.isEmpty {
                summaryRow("wrench.and.screwdriver", conversation.profile.skills.joined(separator: ", "))
            }
            if !conversation.profile.locationLabel.isEmpty {
                summaryRow("mappin.and.ellipse", conversation.profile.locationLabel)
            }
            summaryRow("banknote", "From $\(Int(conversation.profile.hourlyRateFloor))/hr")
            if !conversation.profile.availabilityNotes.isEmpty {
                summaryRow("clock", conversation.profile.availabilityNotes)
            }
            if !conversation.profile.email.isEmpty {
                summaryRow("envelope", conversation.profile.email)
            }
            primaryButton("Looks good", icon: "arrow.right") {
                // One last question: how to sign in. Onboarding only
                // completes once that sign-in succeeds.
                finishInput(userText: "Looks good", mutate: { $0.advance() })
            }
            .disabled(!conversation.profile.isComplete)
            .opacity(conversation.profile.isComplete ? 1 : 0.45)
        }
    }

    private func summaryRow(_ icon: String, _ text: String) -> some View {
        HStack(alignment: .center, spacing: 11) {
            ZStack {
                Circle().fill(HyggeTheme.sageTint).frame(width: 34, height: 34)
                Image(systemName: icon).font(.system(size: 14)).foregroundStyle(GPTheme.teal)
            }
            Text(text).font(.subheadline).foregroundStyle(GPTheme.ink)
            Spacer(minLength: 0)
        }
    }

    /// The .when card: calendar and notifications asked together,
    /// each in its own panel with its own Allow — agreeing to one
    /// never implies the other, and skipping both is one quiet
    /// Continue. Panels stack full-width so copy never squeezes at
    /// large text sizes; the outer card and one primary action
    /// keep the step a single decision, as everywhere in onboarding.
    private var permissionsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            permissionRow(icon: "calendar", title: "Calendar",
                          why: "So I never double-book you, and approved gigs land in your calendar.",
                          granted: calendarGranted) {
                Task { calendarGranted = await PermissionService.requestCalendar() }
            }
            permissionRow(icon: "bell", title: "Notifications",
                          why: "So I can let you know when something needs your OK, or new work turns up.",
                          granted: notificationsGranted) {
                Task {
                    notificationsGranted = await PermissionService.requestNotifications()
                    // Answered once, here — the feed primer must not
                    // ask again later, whichever way this went.
                    store.dismissNotificationPrimer()
                    if notificationsGranted == true { await store.refreshPushState() }
                }
            }
            Text("Both are optional. You can change either any time under Profile, in Permissions.")
                .font(.caption).foregroundStyle(GPTheme.secondary)
                .fixedSize(horizontal: false, vertical: true)
            primaryButton("Continue") {
                submitUser(OnboardingStep.permissionReply(calendar: calendarGranted,
                                                          notifications: notificationsGranted), value: "")
            }
        }
        .task { await loadPermissionStates() }
    }

    /// Show answers the system already holds (a reinstalled app,
    /// an earlier answer) instead of asking again. Only fills in
    /// states this visit has not decided yet.
    private func loadPermissionStates() async {
        if calendarGranted == nil {
            calendarGranted = PermissionService.calendarAuthorization()
        }
        if notificationsGranted == nil {
            switch await PermissionService.notificationAuthorization() {
            case .authorized: notificationsGranted = true
            case .denied: notificationsGranted = false
            case .notDetermined: break
            }
        }
    }

    /// One soft panel, stacked so the words always get the full
    /// width: badge + title on top, the one-line reason under it,
    /// then a filled Allow pill. Side-by-side squeezed the text
    /// into hyphenated one-word lines at large text sizes.
    private func permissionRow(icon: String, title: String, why: String, granted: Bool?,
                               action: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                permissionBadge(icon)
                Text(title).font(.body.weight(.semibold)).foregroundStyle(GPTheme.ink)
                Spacer()
                permissionState(title, granted)
            }
            Text(why).font(.subheadline).foregroundStyle(GPTheme.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if granted == nil { allowPill(title, action) }
        }
        .padding(16)
        .background(GPTheme.paper, in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(GPTheme.hairline, lineWidth: 1))
    }

    private func permissionBadge(_ icon: String) -> some View {
        ZStack {
            Circle().fill(GPTheme.teal.opacity(0.14)).frame(width: 44, height: 44)
            Image(systemName: icon).font(.system(size: 18)).foregroundStyle(GPTheme.teal)
        }
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func permissionState(_ title: String, _ granted: Bool?) -> some View {
        if let granted {
            Label(granted ? "On" : "Off", systemImage: granted ? "checkmark.circle.fill" : "circle")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(granted ? GPTheme.teal : GPTheme.secondary)
                .labelStyle(.iconOnly)
                .accessibilityLabel("\(title) \(granted ? "allowed" : "off")")
        }
    }

    private func allowPill(_ title: String, _ action: @escaping () -> Void) -> some View {
        Button("Allow") { action() }
            .font(.subheadline.weight(.semibold))
            .padding(.horizontal, 22).padding(.vertical, 10)
            // 44pt minimum touch target without growing the pill.
            .frame(minHeight: 44)
            .background(GPTheme.teal, in: Capsule())
            .foregroundStyle(.white)
            .buttonStyle(.plain)
            // Two Allow buttons share this card; VoiceOver must be
            // able to tell them apart without reading the rows.
            .accessibilityLabel("Allow \(title.lowercased()) access")
    }

    /// Town/city field with the locate action as an icon at its
    /// trailing end — no extra row, no instructions.
    private var locationRow: some View {
        HStack(spacing: 6) {
            TextField("Town or city", text: $input)
                .textFieldStyle(.plain)
                .font(.body)
                .textInputAutocapitalization(.words)
                .onSubmit { submitUser(input, value: input); input = "" }
            Button {
                isLocating = true
                Task {
                    let label = await locationService.requestLocality()
                    isLocating = false
                    if let label {
                        input = label
                        conversation.profile.locationLabel = label
                    }
                }
            } label: {
                Group {
                    if isLocating {
                        ProgressView().controlSize(.small).tint(GPTheme.teal)
                    } else {
                        Image(systemName: "location.fill")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(GPTheme.teal)
                    }
                }
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(isLocating)
            .accessibilityLabel("Use my location")
        }
        .padding(.leading, 17).padding(.trailing, 4)
        .padding(.vertical, 3)
        .background(GPTheme.card, in: Capsule())
        .overlay(Capsule().stroke(GPTheme.hairline, lineWidth: 1))
    }

    private func chip(_ label: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if selected { Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)) }
                Text(label).font(.subheadline.weight(selected ? .semibold : .regular))
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.leading)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(selected ? GPTheme.teal : GPTheme.paper, in: Capsule())
            .overlay(Capsule().stroke(selected ? GPTheme.teal : GPTheme.ink.opacity(0.14), lineWidth: 1))
            .foregroundStyle(selected ? .white : GPTheme.ink)
        }
        .buttonStyle(.plain)
    }

    private func textRow(placeholder: String) -> some View {
        TextField(placeholder, text: $input)
            .textFieldStyle(.plain)
            .font(.body)
            .padding(.horizontal, 17).padding(.vertical, 13)
            .background(GPTheme.card, in: Capsule())
            .overlay(Capsule().stroke(GPTheme.hairline, lineWidth: 1))
            .autocorrectionDisabled(false)
            .textInputAutocapitalization(.sentences)
            .onSubmit { submitUser(input, value: input); input = "" }
    }

    private func primaryButton(_ title: String, icon: String? = nil,
                               action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Text(title).font(.body.weight(.semibold))
                if let icon { Image(systemName: icon).font(.system(size: 12, weight: .semibold)) }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            .background(GPTheme.amber, in: Capsule())
            .foregroundStyle(.white)
        }
        .buttonStyle(.plain)
    }

    private func placeholder(for step: OnboardingStep) -> String {
        switch step {
        case .enjoyWork: return "Type another preference..."
        case .where: return "Town or city"
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
        var capped = Array(ordered.prefix(6))
        for selected in conversation.profile.skills where !capped.contains(selected) {
            capped.append(selected)
        }
        return capped
    }

    private func enjoyTile(_ category: OpportunityCategory) -> some View {
        let selected = conversation.profile.interests.contains(category)
        return Button { conversation.toggleCategory(category) } label: {
            // Two-column tiles put the label under the icon so it gets the
            // full tile width (side-by-side hyphenates single words even
            // at small sizes). One-column rows keep icon-left.
            Group {
                if dynamicTypeSize >= .xxLarge {
                    HStack(spacing: 10) {
                        tileIcon(category, selected: selected)
                        tileText(category, selected: selected)
                        Spacer(minLength: 0)
                    }
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        tileIcon(category, selected: selected)
                        tileText(category, selected: selected)
                    }
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 11)
            // Hug the content: the row is only as tall as its
            // tallest tile's label needs, tops aligned.
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(selected ? HyggeTheme.peach : GPTheme.card,
                        in: RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20)
                .stroke(selected ? GPTheme.amber : GPTheme.hairline, lineWidth: selected ? 1.6 : 1))
        }
        .buttonStyle(.plain)
    }

    private func tileIcon(_ category: OpportunityCategory, selected: Bool) -> some View {
        Image(systemName: categoryIcon(category))
            .font(.system(size: 20))
            .foregroundStyle(selected ? GPTheme.amber : GPTheme.teal)
    }

    private func tileText(_ category: OpportunityCategory, selected: Bool) -> some View {
        Text(category.tileLabel)
            .font(.body.weight(selected ? .semibold : .regular))
            .foregroundStyle(selected ? GPTheme.amber : GPTheme.ink)
            .fixedSize(horizontal: false, vertical: true)
            .multilineTextAlignment(.leading)
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

    /// The opener is predefined (OnboardingStep.firstMessage):
    /// one second's pause, then the message and its input card.
    /// No model call, so no "picked for you" header
    /// or skill chips before the user has said anything.
    private func firstTurn() async {
        let thinking = FeedEntry(kind: .thinking)
        entries.append(thinking)
        try? await Task.sleep(for: .seconds(reduceMotion ? 0 : 1))
        replaceEntry(thinking.id, with: OnboardingStep.firstMessage)
        store.appendChat(fromAgent: true, text: OnboardingStep.firstMessage)
        Task {
            try? await Task.sleep(for: .milliseconds(reduceMotion ? 0 : 320))
            appendInputCard()
        }
    }

    /// One generated agent turn, streamed. Nothing shows until the
    /// first token arrives; the input card appears only after the
    /// reply completes.
    private func agentTurn() async {
        guard conversation.step != .done else { return }
        // Arrived signed in (a log in with an unknown email or
        // Apple account just created the account): the final
        // sign-in question is already answered — finish instead.
        if conversation.step == .signIn && store.isSignedIn {
            conversation.advance()
            store.completeOnboarding(profile: conversation.profile)
            return
        }
        // The sign-in question is fixed and local: it never waits on
        // the backend, signed in or not.
        if conversation.step == .signIn {
            entries.append(FeedEntry(kind: .agent, text: OnboardingStep.signIn.prompt))
            store.appendChat(fromAgent: true, text: OnboardingStep.signIn.prompt)
            appendInputCard()
            return
        }
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

