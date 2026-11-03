import SwiftUI

/// A quiet overview. Details live in sheets; live questions stay in chat.
struct HomeFeedView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var focusAnimation
    @State private var focus: FeedFocus?
    @State private var showConversation = false
    @State private var showProfile = false
    @State private var showYourWork = false
    @State private var showNotifications = false
    @State private var showPauseConfirm = false
    @State private var earlierExpanded = false
    @State private var morePlaces = false
    @State private var openCardID: String?
    @State private var undo: FeedUndo?
    @State private var flameDimmed = false
    @State private var dimTask: Task<Void, Never>?

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            HyggeTheme.paper.ignoresSafeArea()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    header.padding(.bottom, 12)
                    if store.isPaused {
                        Button { openFocus(.paused) } label: {
                            FeedSummary(title: "Hygge is paused", subtitle: "Your work is here when you’re ready", icon: "pause")
                        }.buttonStyle(.plain)
                    } else {
                        suggestions
                        opportunities
                        activeTasks
                        decisions
                    }
                    if store.notificationPrimerVisible {
                        card(id: "notifications", title: "A heads-up when you need it", subtitle: "New work and things that need your OK", icon: "bell", primaryTitle: "Permissions", open: { showNotifications = true }, primary: { showNotifications = true }, dismiss: {
                            store.dismissNotificationPrimer()
                            showUndo("Reminder dismissed") { store.undoNotificationDismissal() }
                        })
                    }
                    updates
                    earlier
                    if isEmpty {
                        Text("You’re all caught up.")
                            .font(.system(.title3, design: .rounded, weight: .semibold)).foregroundStyle(HyggeTheme.ink)
                            .padding(.top, 32)
                    }
                    Button("Your work") { showYourWork = true }
                        .font(.subheadline.weight(.medium)).foregroundStyle(HyggeTheme.sageDeep)
                        .frame(minHeight: 44).padding(.top, 8)
                    Color.clear.frame(height: 145)
                }
                .background(GeometryReader { geometry in
                    Color.clear.preference(key: FeedScrollOffset.self, value: geometry.frame(in: .named("feedScroll")).minY)
                })
                .padding(.horizontal, 20).padding(.top, 12)
            }
            .coordinateSpace(name: "feedScroll")
            .onPreferenceChange(FeedScrollOffset.self) { _ in
                flameDimmed = true; dimTask?.cancel()
                dimTask = Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(650))
                    if !Task.isCancelled { flameDimmed = false }
                }
            }
            FloatingFlame(state: flameState, dimmed: flameDimmed) { showConversation = true } onLongPress: { showPauseConfirm = true }
                .padding(.trailing, 18).padding(.bottom, 14)
        }
        .allowsHitTesting(focus == nil)
        .accessibilityHidden(focus != nil)
        .overlay {
            GeometryReader { geometry in
                if let focus {
                    ZStack {
                        Color.black.opacity(0.55).ignoresSafeArea().onTapGesture { closeFocus() }
                            .accessibilityLabel("Back to feed").accessibilityAddTraits(.isButton)
                        FeedFocusCard(close: { closeFocus() }) { focusedContent(focus) }
                            .frame(width: min(geometry.size.width - 32, 620), height: min(geometry.size.height * 0.9, focus.maximumHeight))
                            .matchedGeometryEffect(id: focus.id, in: focusAnimation, isSource: true)
                    }.frame(width: geometry.size.width, height: geometry.size.height)
                    .zIndex(2)
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if let undo {
                HStack(spacing: 12) {
                    Image(systemName: "leaf").foregroundStyle(HyggeTheme.sageDeep)
                    Text(undo.message).font(.subheadline).foregroundStyle(HyggeTheme.ink)
                    Spacer(minLength: 4)
                    Button("Undo") { undo.action(); self.undo = nil }
                        .font(.subheadline.weight(.semibold)).foregroundStyle(HyggeTheme.sageDeep).frame(minHeight: 44)
                }.padding(.horizontal, 16).hyggeCard(radius: 18).padding(.horizontal, 20).padding(.bottom, 8)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .task { await store.observeBrowserTasks() }
        .sheet(isPresented: $showConversation, onDismiss: { store.conversationTaskID = nil }) { ConversationView().presentationDragIndicator(.visible) }
        .sheet(isPresented: $showProfile) { ProfileHubView().presentationDragIndicator(.visible) }
        .sheet(isPresented: $showYourWork) { YourWorkView().presentationDragIndicator(.visible) }
        .sheet(isPresented: $showNotifications) { NavigationStack { SettingsPermissionsView() }.presentationDragIndicator(.visible) }
        .confirmationDialog(store.isPaused ? "Resume Hygge?" : "Pause Hygge?", isPresented: $showPauseConfirm, titleVisibility: .visible) {
            Button(store.isPaused ? "Resume" : "Pause everything") { store.setPaused(!store.isPaused) }
            Button("Cancel", role: .cancel) {}
        }
        .onChange(of: store.pendingTaskOpenID, initial: true) { _, id in
            guard let id else { return }; store.pendingTaskOpenID = nil
            openChat(store.tasks.first { $0.id == id })
        }
        .onChange(of: store.conversationTaskID) { _, id in
            guard id != nil else { return }
            if focus != nil { closeFocus(openChat: true) }
            else { showConversation = true }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Text(greeting).font(.system(.title3, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button { showProfile = true } label: {
                    if store.profilePhotoData != nil { ProfileAvatar(size: 44) }
                    else {
                        Text(String(store.profile.displayName.first ?? "Y").uppercased())
                            .font(.system(.body, design: .rounded, weight: .semibold))
                            .foregroundStyle(HyggeTheme.ink).frame(width: 44, height: 44).background(HyggeTheme.sageTint, in: Circle())
                    }
                }.buttonStyle(.plain).accessibilityLabel("Your profile")
            }
            if let error = store.lastSyncError {
                Label(error, systemImage: "wifi.slash").font(.caption).foregroundStyle(HyggeTheme.ember)
            }
        }
    }
    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        let name = store.profile.displayName.split(separator: " ").first.map(String.init) ?? ""
        let time = hour < 12 ? "Morning" : hour < 18 ? "Afternoon" : "Evening"
        return name.isEmpty ? "Good \(time.lowercased())" : "\(time), \(name)"
    }
    private var flameState: FlameState {
        if store.needsYouCount > 0 { return .needsYou(store.needsYouCount) }
        return store.isAgentWorking ? .working : .asleep
    }
    private var pendingProposals: [ProposedSite] { store.proposals.filter { $0.status == .proposed } }
    private var listings: [Opportunity] {
        store.opportunities.filter { !$0.isDemo && ($0.status == .new || $0.status == .saved) }
            .filter { opportunity in !store.applications.contains { $0.opportunityID == opportunity.id } }
            .sorted { lhs, rhs in
                if lhs.id == store.highlightedOpportunityID { return true }
                if rhs.id == store.highlightedOpportunityID { return false }
                return (lhs.rankScore ?? 0) > (rhs.rankScore ?? 0)
            }
    }
    private var decisionTasks: [AgentTask] {
        store.tasks.filter { $0.needsChatHelp || $0.status == .awaitingApproval || $0.status == .draft }
    }
    private var runningTasks: [AgentTask] { store.tasks.filter { $0.status == .running || $0.status == .approved } }
    private var events: [ActivityEvent] { store.activityEvents.sorted { $0.occurredAt > $1.occurredAt } }
    private var isEmpty: Bool { pendingProposals.isEmpty && listings.isEmpty && decisionTasks.isEmpty && runningTasks.isEmpty && events.isEmpty && !store.isPaused }
    private func taskKey(_ task: AgentTask) -> String { FeedFocus.taskKey(task) }
    private func eventKey(_ event: ActivityEvent) -> String { "event-\(event.id)" }
    private func isArchived(_ id: String) -> Bool { store.archivedFeedIDs.contains(id) }

    private var suggestions: some View {
        Group {
            ForEach(pendingProposals.prefix(morePlaces ? pendingProposals.count : 1)) { proposal in
                card(id: "proposal-\(proposal.id)", title: store.siteName(id: proposal.siteID), subtitle: proposal.rationale,
                     icon: "link", style: .invitation, primaryTitle: "Start setup", primaryIcon: "sparkles",
                     open: { openFocus(.proposal(proposal)) },
                     primary: { store.approveProposal(proposalID: proposal.id, alreadyHasAccount: false) },
                     dismiss: {
                        store.dismissProposal(proposalID: proposal.id)
                        showUndo("Suggestion dismissed") { store.undoSiteDismissal(proposalID: proposal.id) }
                     })
            }
            if pendingProposals.count > 1 {
                Button(morePlaces ? "Fewer suggestions" : "\(pendingProposals.count - 1) more places") { withAnimation { morePlaces.toggle() } }
                    .font(.caption.weight(.medium)).foregroundStyle(HyggeTheme.sageDeep).frame(minHeight: 44)
            }
        }
    }
    private var opportunities: some View {
        ForEach(listings) { opportunity in
            card(id: "opportunity-\(opportunity.id)", title: opportunity.title,
                 subtitle: "\(opportunity.payLabel) · \(opportunity.isRemote ? "Remote" : opportunity.locationLabel)",
                 icon: opportunity.category == .creative ? "paintpalette" : "briefcase", style: .opportunity, primaryTitle: "Prepare draft", primaryIcon: "square.and.pencil",
                 open: { openFocus(.opportunity(opportunity)) }, primary: { store.draftApplication(for: opportunity) },
                 dismiss: {
                    store.setStatus(.dismissed, for: opportunity.id)
                    showUndo("Opportunity dismissed") { store.setStatus(opportunity.status, for: opportunity.id) }
                 })
        }
    }
    private var activeTasks: some View {
        ForEach(runningTasks.filter { !isArchived(taskKey($0)) }) { task in
            if task.browserSessionID != nil {
                SwipeFeedCard(id: taskKey(task), primaryTitle: "Watch", primaryIcon: "arrow.up.left.and.arrow.down.right", openCardID: $openCardID, open: { openFocus(.browser(task)) }, primary: { openFocus(.browser(task)) }, dismiss: { archive(taskKey(task)) }) {
                VStack(alignment: .leading, spacing: 10) {
                    Text(task.connectsExistingAccount ? "Connecting your account" : task.kind == .buildProfile ? "Building your profile" : task.isSiteSetup ? "Setting up your account" : task.title)
                        .font(.system(.subheadline, design: .rounded, weight: .semibold)).foregroundStyle(HyggeTheme.ink)
                    BrowserLiveAttachment(task: task) { openFocus(.browser(task)) }
                }.padding(14).hyggeCard(radius: 22)
                }
                .matchedGeometryEffect(id: taskKey(task), in: focusAnimation, isSource: focus?.id != taskKey(task))
                .opacity(focus?.id == taskKey(task) ? 0 : 1)
            } else {
                card(id: taskKey(task), title: "\(store.siteName(id: task.siteID)) · Working", subtitle: task.title,
                     icon: "sparkles", primaryTitle: "Details", open: { openFocus(.task(task)) }, primary: { openFocus(.task(task)) })
            }
        }
    }
    private var decisions: some View {
        ForEach(decisionTasks.filter { !isArchived(taskKey($0)) }) { task in taskCard(task) }
    }
    private func taskCard(_ task: AgentTask) -> some View {
        let chat = task.needsChatHelp
        let approval = task.help?.kind == .approval
        return card(id: taskKey(task), title: taskTitle(task),
                    subtitle: store.siteName(id: task.siteID), icon: taskIcon(task), usesProfilePhoto: task.kind == .buildProfile, style: chat && !approval ? .question : .review,
                    primaryTitle: chat && !approval ? "Open chat" : "Review", primaryIcon: chat ? "bubble.left" : "doc.text.magnifyingglass",
                    open: { if chat { openChat(task) } else { openFocus(.task(task)) } },
                    primary: { if chat { openChat(task) } else { openFocus(.task(task)) } })
    }
    private func taskIcon(_ task: AgentTask) -> String {
        if task.needsChatHelp {
            switch task.help?.kind {
            case .approval: return "doc.text.magnifyingglass"
            case .verification: return "checkmark.shield"
            case .credentials: return "key"
            case .recovery: return "arrow.clockwise"
            default: return "bubble.left.and.bubble.right"
            }
        }
        switch task.kind {
        case .buildProfile: return "person.text.rectangle"
        case .apply: return "envelope.open"
        case .message: return "paperplane"
        case .bookCalendar: return "calendar.badge.plus"
        case .signup: return "globe"
        case .discover: return "magnifyingglass"
        }
    }
    private func taskTitle(_ task: AgentTask) -> String {
        if task.needsChatHelp {
            switch task.help?.kind {
            case .approval: return "Ready for your review"
            case .verification: return "A quick check needs you"
            case .credentials: return "Connect your login"
            case .recovery: return "Let’s get this moving"
            case .information: return "One quick question"
            case nil: return "Your help is needed"
            }
        }
        return task.kind == .buildProfile ? "Profile ready to review" : task.title
    }
    private var updates: some View {
        ForEach(events.filter { $0.occurredAt > store.visitMarker && !isArchived(eventKey($0)) }) { event in eventCard(event) }
    }
    private var earlier: some View {
        let older = events.filter { $0.occurredAt <= store.visitMarker || isArchived(eventKey($0)) }
        let deferred = (decisionTasks + runningTasks).filter { isArchived(taskKey($0)) }
        return Group {
            if !older.isEmpty || !deferred.isEmpty {
                Button { withAnimation { earlierExpanded.toggle() } } label: {
                    HStack {
                        Text("Earlier").font(.subheadline.weight(.semibold))
                        Image(systemName: earlierExpanded ? "chevron.up" : "chevron.down").font(.caption)
                        Spacer()
                    }.foregroundStyle(HyggeTheme.secondary).frame(minHeight: 44)
                }.padding(.top, 8)
                if earlierExpanded {
                    ForEach(deferred) { task in taskCard(task) }
                    ForEach(older) { event in eventCard(event) }
                }
            }
        }
    }
    private func eventCard(_ event: ActivityEvent) -> some View {
        card(id: eventKey(event), title: FeedEventPresentation.title(event),
             subtitle: event.siteID.map { store.siteName(id: $0) } ?? JournalBuilder.dayLabel(for: event.occurredAt),
             icon: FeedEventPresentation.icon(event), asset: event.kind == .workCompleted ? "SettingsEarnings" : nil, style: eventStyle(event),
             primaryTitle: "Details", open: { openFocus(.event(event)) }, primary: { openFocus(.event(event)) })
    }
    private func card(id: String, title: String, subtitle: String, icon: String, asset: String? = nil, usesProfilePhoto: Bool = false, style: FeedCardStyle = .update,
                      primaryTitle: String, primaryIcon: String = "arrow.right", open: @escaping () -> Void,
                      primary: @escaping () -> Void, dismiss: (() -> Void)? = nil) -> some View {
        SwipeFeedCard(id: id, primaryTitle: primaryTitle, primaryIcon: primaryIcon, openCardID: $openCardID,
                      open: { openCardID = nil; open() }, primary: primary, dismiss: dismiss ?? { archive(id) }) {
            FeedVisualCard(style: style, title: title, subtitle: subtitle, icon: icon, asset: asset, usesProfilePhoto: usesProfilePhoto)
        }
        .matchedGeometryEffect(id: id, in: focusAnimation, isSource: focus?.id != id)
        .opacity(focus?.id == id ? 0 : 1)
    }
    private func archive(_ id: String) {
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { store.setFeedArchived(id, archived: true) }
        showUndo("Moved to Earlier") { store.setFeedArchived(id, archived: false) }
    }
    private func showUndo(_ message: String, action: @escaping () -> Void) {
        withAnimation { undo = FeedUndo(message: message, action: action) }
    }
    private func openChat(_ task: AgentTask?) {
        if let task { store.surfaceTaskHelp(taskID: task.id); store.conversationTaskID = task.id }
        showConversation = true
    }
    private func openFocus(_ value: FeedFocus) {
        openCardID = nil
        withAnimation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.42, dampingFraction: 0.86)) { focus = value }
    }
    private func closeFocus(openChat: Bool = false) {
        withAnimation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.42, dampingFraction: 0.86)) { focus = nil }
        if openChat || store.conversationTaskID != nil { showConversation = true }
    }
    private func eventStyle(_ event: ActivityEvent) -> FeedCardStyle {
        if event.kind == .workCompleted, let amount = event.grossAmount { return .earnings(amount, event.currencyCode) }
        if event.kind == .joinedSite || event.kind == .profileLive { return .celebration }
        return .update
    }
    @ViewBuilder private func focusedContent(_ value: FeedFocus) -> some View {
        switch value {
        case .proposal(let proposal): FeedProposalDetail(close: { closeFocus() }, proposalID: proposal.id)
        case .opportunity(let opportunity): FeedOpportunityDetail(close: { closeFocus() }, opportunityID: opportunity.id)
        case .event(let event): FeedEventDetail(event: event)
        case .task(let task): FeedTaskReview(close: { closeFocus() }, taskID: task.id)
        case .browser(let task): CloudBrowserView(urlString: task.targetURLString, existingSessionID: task.browserSessionID, taskID: task.id, onClose: { closeFocus() })
        case .paused:
            FeedDetailContent {
                Text("Hygge is paused").font(.title2.bold()).foregroundStyle(HyggeTheme.ink)
                Text("Searching, sending and booking will wait until you resume.").foregroundStyle(HyggeTheme.secondary)
                FeedPrimaryButton(title: "Resume Hygge") { store.setPaused(false); closeFocus() }
            }
        }
    }
}

private struct FeedScrollOffset: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct FeedUndo { let message: String; let action: () -> Void }

enum FeedEventPresentation {
    static func title(_ event: ActivityEvent) -> String {
        switch event.kind {
        case .joinedSite: return "Your account is ready"
        case .profileLive: return "Your profile is live"
        case .workCompleted:
            if let amount = event.grossAmount { return "You earned \(JournalBuilder.money(amount, currencyCode: event.currencyCode))" }
            return "Work completed"
        case .applicationSent: return "Application sent"
        case .messageSent: return "Message sent"
        case .booked: return "It’s in your calendar"
        default: return event.sentence
        }
    }
    static func icon(_ event: ActivityEvent) -> String {
        switch event.kind {
        case .joinedSite, .profileLive: return "checkmark.circle.fill"
        case .workCompleted: return "banknote"
        case .applicationSent: return "paperplane"
        case .messageSent: return "bubble.left"
        case .booked: return "calendar"
        case .filedEmail: return "envelope"
        case .searchedSite: return "magnifyingglass"
        case .learnedAboutSite: return "map"
        }
    }
}
