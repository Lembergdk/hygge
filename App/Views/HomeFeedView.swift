import SwiftUI

/// A visual overview. Details expand over the feed; live questions stay in chat.
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
    @State private var updateGate = FeedUpdateGate()
    @State private var isAtTop = true
    @State private var scrollAnchor: String?

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            HyggeTheme.paper.ignoresSafeArea()
            feedScroll
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
        .onChange(of: candidateIDs, initial: true) { _, _ in receiveFeedUpdates() }
        .onChange(of: focus == nil && !showConversation && !showProfile && !showYourWork && !showNotifications) { _, available in
            if available { receiveFeedUpdates() }
        }
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

    private var feedScroll: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    header.padding(.bottom, 12).id("feed-top")
                    ForEach(feedRows) { row in
                        feedRow(row).id(row.id).transition(arrivalTransition)
                    }
                    if isEmpty && updateGate.pendingIDs.isEmpty {
                        Text("You’re all caught up.")
                            .font(.system(.title3, design: .rounded, weight: .semibold)).foregroundStyle(HyggeTheme.ink)
                            .padding(.top, 32)
                    }
                    Button("Your work") { showYourWork = true }
                        .font(.subheadline.weight(.medium)).foregroundStyle(HyggeTheme.sageDeep)
                        .frame(minHeight: 44).padding(.top, 8)
                    Color.clear.frame(height: 145)
                }
                .scrollTargetLayout()
                .background(GeometryReader { geometry in
                    Color.clear.preference(key: FeedScrollOffset.self, value: geometry.frame(in: .named("feedScroll")).minY)
                })
                .onPreferenceChange(FeedScrollOffset.self) { origin in
                    if #unavailable(iOS 18.0), let origin { trackScroll(12 - origin) }
                }
                .padding(.horizontal, 20).padding(.top, 12)
            }
            .scrollPosition(id: $scrollAnchor, anchor: .top)
            .onChange(of: updateGate.visibleIDs) { _, _ in
                if isAtTop { proxy.scrollTo("feed-top", anchor: .top) }
            }
            .coordinateSpace(name: "feedScroll")
            .modifier(FeedScrollTracking(onOffset: trackScroll))
            .overlay(alignment: .top) {
                if !updateGate.pendingIDs.isEmpty {
                    Button {
                        // Insertion waits for the top geometry callback; the
                        // button never inserts cards underneath a scrolled reader.
                        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.35)) {
                            proxy.scrollTo("feed-top", anchor: .top)
                        }
                        if isAtTop { receiveFeedUpdates() }
                    } label: {
                        Label("New updates", systemImage: "arrow.up")
                            .font(.system(.subheadline, design: .rounded, weight: .semibold))
                            .foregroundStyle(HyggeTheme.onSage)
                            .padding(.horizontal, 20).frame(minHeight: 44)
                            .background(HyggeTheme.sageDeep, in: Capsule())
                            .shadow(color: .black.opacity(0.2), radius: 10, y: 4)
                    }.buttonStyle(.plain)
                        .accessibilityHint("Returns to the top and shows new feed entries")
                        .padding(.top, 8).transition(.opacity)
                }
            }
        }
    }

    private func trackScroll(_ offset: CGFloat) {
        let atTop = offset <= 12
        if isAtTop != atTop {
            isAtTop = atTop
            if atTop { receiveFeedUpdates() }
        }
        flameDimmed = true; dimTask?.cancel()
        dimTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(650))
            if !Task.isCancelled { flameDimmed = false }
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
    private var proposedSites: [ProposedSite] { store.proposals.filter { $0.status == .proposed } }
    private var pendingProposals: [ProposedSite] { admitted(proposedSites) { "proposal-\($0.id)" } }
    private var availableListings: [Opportunity] {
        store.opportunities.filter { !$0.isDemo && ($0.status == .new || $0.status == .saved) }
            .filter { opportunity in !store.applications.contains { $0.opportunityID == opportunity.id } }
            .sorted { lhs, rhs in
                if lhs.id == store.highlightedOpportunityID { return true }
                if rhs.id == store.highlightedOpportunityID { return false }
                return (lhs.rankScore ?? 0) > (rhs.rankScore ?? 0)
            }
    }
    private var listings: [Opportunity] { admitted(availableListings) { "opportunity-\($0.id)" } }
    private var availableDecisions: [AgentTask] {
        store.tasks.filter { !$0.isActiveInFeed && ($0.needsChatHelp || $0.status == .awaitingApproval || $0.status == .draft) }
    }
    private var decisionTasks: [AgentTask] { admitted(availableDecisions, key: taskKey) }
    private var availableActiveTasks: [AgentTask] { store.tasks.filter(\.isActiveInFeed) }
    private var runningTasks: [AgentTask] { admitted(availableActiveTasks, key: taskKey) }
    private var availableEvents: [ActivityEvent] { store.activityEvents.sorted { $0.occurredAt > $1.occurredAt } }
    private var events: [ActivityEvent] { admitted(availableEvents, key: eventKey) }
    private var candidateIDs: [String] {
        var ids = availableActiveTasks.map(taskKey)
        ids += proposedSites.map { "proposal-\($0.id)" }
        ids += availableListings.map { "opportunity-\($0.id)" }
        ids += availableDecisions.map(taskKey)
        if store.notificationPrimerVisible { ids.append("notifications") }
        ids += availableEvents.map(eventKey)
        return ids
    }
    private func admitted<Item>(_ items: [Item], key: (Item) -> String) -> [Item] {
        let positions = Dictionary(uniqueKeysWithValues: updateGate.visibleIDs.enumerated().map { ($0.element, $0.offset) })
        return items.filter { positions[key($0)] != nil }
            .sorted { (positions[key($0)] ?? 0) < (positions[key($1)] ?? 0) }
    }
    private func receiveFeedUpdates() {
        let canInsert = isAtTop && focus == nil && !showConversation && !showProfile && !showYourWork && !showNotifications
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--feed-arrivals-preview") { print("FEED_RECEIVE top=\(isAtTop) insert=\(canInsert) visible=\(updateGate.visibleIDs.count) latest=\(candidateIDs.count)") }
        #endif
        withAnimation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.45, dampingFraction: 0.88)) {
            updateGate.receive(candidateIDs, atTop: canInsert)
        }
    }
    private var isEmpty: Bool { pendingProposals.isEmpty && listings.isEmpty && decisionTasks.isEmpty && runningTasks.isEmpty && events.isEmpty && !store.isPaused }
    private func taskKey(_ task: AgentTask) -> String { FeedFocus.taskKey(task) }
    private func eventKey(_ event: ActivityEvent) -> String { "event-\(event.id)" }
    private func isArchived(_ id: String) -> Bool { store.archivedFeedIDs.contains(id) }

    private func proposalCard(_ proposal: ProposedSite) -> some View {
        card(id: "proposal-\(proposal.id)", title: store.siteName(id: proposal.siteID), subtitle: proposal.rationale,
             icon: "link", style: .invitation, primaryTitle: "Start setup", primaryIcon: "sparkles",
             open: { openFocus(.proposal(proposal)) },
             primary: { store.approveProposal(proposalID: proposal.id, alreadyHasAccount: false) },
             dismiss: {
                store.dismissProposal(proposalID: proposal.id)
                showUndo("Suggestion dismissed", restoring: "proposal-\(proposal.id)") { store.undoSiteDismissal(proposalID: proposal.id) }
             })
    }
    private func opportunityCard(_ opportunity: Opportunity) -> some View {
        card(id: "opportunity-\(opportunity.id)", title: opportunity.title,
             subtitle: "\(opportunity.payLabel) · \(opportunity.isRemote ? "Remote" : opportunity.locationLabel)",
             icon: opportunity.category == .creative ? "paintpalette" : "briefcase", style: .opportunity, primaryTitle: "Prepare draft", primaryIcon: "square.and.pencil",
             open: { openFocus(.opportunity(opportunity)) }, primary: { store.draftApplication(for: opportunity) },
             dismiss: {
                store.setStatus(.dismissed, for: opportunity.id)
                showUndo("Opportunity dismissed", restoring: "opportunity-\(opportunity.id)") { store.setStatus(opportunity.status, for: opportunity.id) }
             })
    }
    @ViewBuilder private func activeTaskCard(_ task: AgentTask) -> some View {
        if task.browserSessionID != nil {
            SwipeFeedCard(id: taskKey(task), primaryTitle: task.needsChatHelp ? "Open chat" : "Watch", primaryIcon: task.needsChatHelp ? "bubble.left" : "arrow.up.left.and.arrow.down.right", openCardID: $openCardID, open: { openActiveTask(task) }, primary: { openActiveTask(task) }, dismiss: {}, allowsDismissal: false) {
            VStack(alignment: .leading, spacing: 10) {
                Text(task.needsChatHelp ? taskTitle(task) : task.connectsExistingAccount ? "Connecting your account" : task.kind == .buildProfile ? "Building your profile" : task.isSiteSetup ? "Setting up your account" : task.title)
                    .font(.system(.subheadline, design: .rounded, weight: .semibold)).foregroundStyle(HyggeTheme.ink)
                BrowserLiveAttachment(task: task) { openFocus(.browser(task)) }
            }.padding(14).hyggeCard(radius: 22)
            }
            .matchedGeometryEffect(id: taskKey(task), in: focusAnimation, isSource: focus?.id != taskKey(task))
            .opacity(focus?.id == taskKey(task) ? 0 : 1)
        } else {
            card(id: taskKey(task), title: "\(store.siteName(id: task.siteID)) · Working", subtitle: task.title,
                 icon: "sparkles", primaryTitle: "Details", open: { openFocus(.task(task)) }, primary: { openFocus(.task(task)) }, allowsDismissal: false)
        }
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
    // One flat, stably identified row collection lets SwiftUI preserve the
    // visible card when a live session above the reader finishes.
    private var feedRows: [FeedRow] {
        var rows = runningTasks.map(FeedRow.active)
        if store.isPaused { rows.append(.paused) }
        else {
            rows += pendingProposals.prefix(morePlaces ? pendingProposals.count : 1).map(FeedRow.proposal)
            if pendingProposals.count > 1 { rows.append(.morePlaces) }
            rows += listings.map(FeedRow.opportunity)
            rows += decisionTasks.filter { !isArchived(taskKey($0)) }.map(FeedRow.decision)
        }
        if store.notificationPrimerVisible && updateGate.visibleIDs.contains("notifications") { rows.append(.notifications) }
        if !events.isEmpty { rows.append(.journal) }
        rows += events.filter { $0.occurredAt > store.visitMarker && !isArchived(eventKey($0)) }.map(FeedRow.event)
        let older = events.filter { $0.occurredAt <= store.visitMarker || isArchived(eventKey($0)) }
        let deferred = decisionTasks.filter { isArchived(taskKey($0)) }
        if !older.isEmpty || !deferred.isEmpty {
            rows.append(.earlier)
            if earlierExpanded {
                rows += deferred.map(FeedRow.decision)
                rows += older.map(FeedRow.event)
            }
        }
        return rows
    }
    @ViewBuilder private func feedRow(_ row: FeedRow) -> some View {
        switch row {
        case .active(let task): activeTaskCard(task)
        case .proposal(let proposal): proposalCard(proposal)
        case .opportunity(let opportunity): opportunityCard(opportunity)
        case .decision(let task): taskCard(task)
        case .event(let event): eventCard(event)
        case .paused:
            Button { openFocus(.paused) } label: {
                FeedSummary(title: "Hygge is paused", subtitle: "Your work is here when you’re ready", icon: "pause")
            }.buttonStyle(.plain)
        case .morePlaces:
            Button(morePlaces ? "Fewer suggestions" : "\(pendingProposals.count - 1) more places") { withAnimation { morePlaces.toggle() } }
                .font(.caption.weight(.medium)).foregroundStyle(HyggeTheme.sageDeep).frame(minHeight: 44)
        case .notifications:
            card(id: "notifications", title: "A heads-up when you need it", subtitle: "New work and things that need your OK", icon: "bell", primaryTitle: "Permissions", open: { showNotifications = true }, primary: { showNotifications = true }, dismiss: {
                store.dismissNotificationPrimer()
                showUndo("Reminder dismissed", restoring: "notifications") { store.undoNotificationDismissal() }
            })
        case .journal:
            Text("Journal").font(.system(.title3, design: .rounded, weight: .bold))
                .foregroundStyle(HyggeTheme.ink).padding(.top, 12)
        case .earlier:
            Button { withAnimation { earlierExpanded.toggle() } } label: {
                HStack {
                    Text("Earlier").font(.subheadline.weight(.semibold))
                    Image(systemName: earlierExpanded ? "chevron.up" : "chevron.down").font(.caption)
                    Spacer()
                }.foregroundStyle(HyggeTheme.secondary).frame(minHeight: 44)
            }.padding(.top, 8)
        }
    }
    private func eventCard(_ event: ActivityEvent) -> some View {
        card(id: eventKey(event), title: FeedEventPresentation.title(event),
             subtitle: event.siteID.map { store.siteName(id: $0) } ?? JournalBuilder.dayLabel(for: event.occurredAt),
             icon: FeedEventPresentation.icon(event), asset: event.kind == .workCompleted ? "SettingsEarnings" : nil, style: event.kind == .workCompleted ? eventStyle(event) : .update,
             primaryTitle: "Details", open: { openFocus(.event(event)) }, primary: { openFocus(.event(event)) })
    }
    private func card(id: String, title: String, subtitle: String, icon: String, asset: String? = nil, usesProfilePhoto: Bool = false, style: FeedCardStyle = .update,
                      primaryTitle: String, primaryIcon: String = "arrow.right", open: @escaping () -> Void,
                      primary: @escaping () -> Void, dismiss: (() -> Void)? = nil, allowsDismissal: Bool = true) -> some View {
        SwipeFeedCard(id: id, primaryTitle: primaryTitle, primaryIcon: primaryIcon, openCardID: $openCardID,
                      open: { openCardID = nil; open() }, primary: primary, dismiss: dismiss ?? { archive(id) }, allowsDismissal: allowsDismissal) {
            FeedVisualCard(style: style, title: title, subtitle: subtitle, icon: icon, asset: asset, usesProfilePhoto: usesProfilePhoto)
        }
        .matchedGeometryEffect(id: id, in: focusAnimation, isSource: focus?.id != id)
        .opacity(focus?.id == id ? 0 : 1)
    }
    private var arrivalTransition: AnyTransition {
        reduceMotion ? .opacity : .asymmetric(insertion: .move(edge: .top).combined(with: .opacity), removal: .opacity)
    }
    private func openActiveTask(_ task: AgentTask) {
        if task.needsChatHelp { openChat(task) }
        else { openFocus(.browser(task)) }
    }
    private func archive(_ id: String) {
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { store.setFeedArchived(id, archived: true) }
        showUndo("Moved to Earlier") { store.setFeedArchived(id, archived: false) }
    }
    private func showUndo(_ message: String, restoring id: String? = nil, action: @escaping () -> Void) {
        let index = id.flatMap { updateGate.visibleIDs.firstIndex(of: $0) } ?? 0
        withAnimation {
            undo = FeedUndo(message: message, action: {
                action()
                if let id { updateGate.restore(id, at: index) }
            })
        }
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
    static var defaultValue: CGFloat? = nil
    static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) { value = nextValue() ?? value }
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

/// Use the scroll view's actual offset on modern iOS. The iOS 17 fallback
/// observes the content preference inside the lazy container, where it exists.
private struct FeedScrollTracking: ViewModifier {
    let onOffset: (CGFloat) -> Void
    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollGeometryChange(for: CGFloat.self) { geometry in
                geometry.contentOffset.y + geometry.contentInsets.top
            } action: { _, offset in onOffset(offset) }
        } else { content }
    }
}

private enum FeedRow: Identifiable {
    case active(AgentTask), proposal(ProposedSite), opportunity(Opportunity), decision(AgentTask), event(ActivityEvent)
    case paused, morePlaces, notifications, journal, earlier
    var id: String {
        switch self {
        case .active(let task), .decision(let task): return FeedFocus.taskKey(task)
        case .proposal(let value): return "proposal-\(value.id)"
        case .opportunity(let value): return "opportunity-\(value.id)"
        case .event(let value): return "event-\(value.id)"
        case .paused: return "paused"
        case .morePlaces: return "more-places"
        case .notifications: return "notifications"
        case .journal: return "journal-heading"
        case .earlier: return "earlier"
        }
    }
}
