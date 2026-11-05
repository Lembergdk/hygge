import SwiftUI

/// A visual overview. Details expand over the feed; live questions stay in chat.
struct HomeFeedView: View {
    @Environment(AppStore.self) private var store
    @Environment(FlamePlayStore.self) private var playStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Namespace private var focusAnimation
    @State private var focus: FeedFocus?
    @State private var showConversation = false
    @State private var showBubbleChat = false
    @State private var flameTraveling = false
    @State private var keyboardHeight: CGFloat = 0
    @State private var dragStartCenter: CGPoint?
    /// Window-space center while he hops between spots (overrides the
    /// placement-derived center so the hop itself animates).
    /// Visual offset while hopping between spots: layout sits at the
    /// target placement, the offset (start - target, animated to zero)
    /// draws him along the way. Driving .position itself through an
    /// optional override snapped him off-screen for a frame on close.
    @State private var hopOffset: CGSize = .zero
    /// Downward drag on the chat bubble's grabber, in points: the
    /// bubble collapses (bottom anchored, top edge follows the
    /// finger), then either springs back open or closes past the
    /// threshold. It never translates the whole bubble.
    @State private var bubbleDragOffset: CGFloat = 0
    /// While the chat bubble is open he perches a little higher, fully
    /// on screen under its tail, instead of clipped by the bottom edge.
    @State private var chatLift: CGFloat = 0
    private var chatLiftAmount: CGFloat { 28 }
    /// Where he was living before a tap sent him home for chat.
    @State private var returnPlacement: FlamePlacement?

    @State private var showProfile = false
    @State private var showPlus = false
    @State private var showNotifications = false
    @State private var emailOpenItem: FiledEmailSummary?
    @State private var earlierExpanded = false
    @State private var moreSites = false
    @State private var openCardID: String?
    @State private var undo: FeedUndo?
    @State private var flameDimmed = false
    @State private var dimTask: Task<Void, Never>?
    @State private var updateGate = FeedUpdateGate()
    @State private var isAtTop = true
    @State private var scrollAnchor: String?

    var body: some View {
        GeometryReader { geo in
            ZStack {
                HyggeTheme.paper.ignoresSafeArea()
                feedScroll
                if showBubbleChat {
                    Color.black.opacity(0.18).ignoresSafeArea()
                        .onTapGesture { closeBubble() }
                        .transition(.opacity)
                }
                // He lives where he was dropped (placement persists in the
                // flame settings); nil placement is his bottom-right home.
                FloatingFlame(state: flameState, dimmed: flameDimmed,
                              traveling: flameTraveling,
                              browsing: store.hasActiveBrowserSession) {
                    flameTapped()
                }
                onDragBegan: { dragStartCenter = flameWindowCenter() }
                onDragEnded: { translation in commitDrag(translation) }
                    .position(flameCenter(in: geo))
                    .offset(x: hopOffset.width, y: hopOffset.height + chatLift)
                    // Above the chat bubble (zIndex 3): on close he hops
                    // back THROUGH the bubble's fading rectangle, and
                    // behind it he vanished until the fade finished.
                    .zIndex(4)
                if showBubbleChat {
                    bubbleChat(in: geo)
                }
            }
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
                            // Short cards keep their natural height; longer content
                            // scrolls inside this viewport, including at large type.
                            .frame(width: min(geometry.size.width - 32, 620))
                            .frame(maxHeight: dynamicTypeSize.isAccessibilitySize
                                       ? geometry.size.height * 0.92
                                       : min(geometry.size.height * 0.92, focus.maximumHeight))
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
        .task { await store.refreshHyggeEmail(); await store.observeBrowserTasks() }
        .onReceive(NotificationCenter.default.publisher(
            for: UIResponder.keyboardWillChangeFrameNotification)) { note in
            guard let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect
            else { return }
            let overlap = UIScreen.main.bounds.height - frame.origin.y
            withAnimation(.easeInOut(duration: 0.25)) {
                keyboardHeight = max(0, overlap)
            }
        }
        .onChange(of: candidateIDs, initial: true) { _, _ in receiveFeedUpdates() }
        .onChange(of: focus == nil && !showConversation && !showProfile && !showNotifications) { _, available in
            if available { receiveFeedUpdates() }
        }
        // With nothing actionable in the feed, the journal IS the feed:
        // its Earlier section starts expanded. Once the user collapses
        // it, their choice stands until the feed next becomes busy
        // and empties again.
        .onChange(of: hasActionableFeedItems, initial: true) { _, hasItems in
            if !hasItems {
                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.25)) { earlierExpanded = true }
            }
        }
        .sheet(isPresented: $showConversation, onDismiss: { store.conversationTaskID = nil }) { ConversationView().presentationDragIndicator(.visible) }
        .sheet(isPresented: $showProfile) { ProfileHubView().presentationDragIndicator(.visible) }
        .sheet(isPresented: $showPlus) { NavigationStack { PlusSheetView() }.presentationDragIndicator(.visible) }
        .sheet(isPresented: $showNotifications) { NavigationStack { SettingsPermissionsView() }.presentationDragIndicator(.visible) }
        .sheet(item: $emailOpenItem) { mail in
            NavigationStack { FiledEmailDetailView(mail: mail) }.presentationDragIndicator(.visible)
        }
        .onChange(of: store.pendingTaskOpenID, initial: true) { _, id in
            guard let id else { return }; store.pendingTaskOpenID = nil
            openChat(store.tasks.first { $0.id == id })
        }
        // A tapped push opens the exact element it named: whatever
        // is presented closes first, then the element itself opens.
        .onChange(of: store.pendingOpportunityOpenID, initial: true) { _, id in
            guard let id else { return }; store.pendingOpportunityOpenID = nil
            guard let opportunity = store.opportunities.first(where: { $0.id == id }) else { return }
            dismissPresented()
            receiveFeedUpdates()
            openFocus(.opportunity(opportunity))
        }
        .onChange(of: store.pendingEmailOpenID, initial: true) { _, id in
            guard let id else { return }; store.pendingEmailOpenID = nil
            guard let mail = store.filedEmailSummaries.first(where: { $0.id.lowercased() == id.uuidString.lowercased() }) else { return }
            dismissPresented()
            emailOpenItem = mail
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
                    Color.clear.frame(height: 175)
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
            .refreshable { await store.refreshFeed() }
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
    // MARK: - Free-roaming flame & speech-bubble chat

    private var flameFrameW: CGFloat { CGFloat(playStore.settings.homeFlameSize) + 14 }
    private var flameFrameH: CGFloat { CGFloat(playStore.settings.homeFlameSize) * 1.25 + 18 }
    private var screenSize: CGSize { UIScreen.main.bounds.size }

    /// All placement math happens in window coordinates (stable no matter
    /// how SwiftUI insets or shrinks the feed geometry for the keyboard),
    /// then converts into the geometry's local space for `.position`.
    private func windowCenter(for placement: FlamePlacement?) -> CGPoint {
        let home = CGPoint(x: screenSize.width - flameFrameW / 2 - 14,
                           y: screenSize.height - flameFrameH / 2 - 2)
        guard let p = placement else { return home }
        return CGPoint(
            x: min(max(CGFloat(p.x) * screenSize.width, flameFrameW / 2 + 4),
                   screenSize.width - flameFrameW / 2 - 4),
            y: min(max(CGFloat(p.y) * screenSize.height, flameFrameH / 2 + 50),
                   screenSize.height - flameFrameH / 2 + 14))
    }

    /// Where layout puts him (his placement spot), before hop offset.
    private func flameLayoutCenter() -> CGPoint {
        windowCenter(for: playStore.settings.placement)
    }

    /// Where he is actually drawn right now, hop and chat offsets in.
    private func flameWindowCenter() -> CGPoint {
        let c = flameLayoutCenter()
        return CGPoint(x: c.x + hopOffset.width,
                       y: c.y + hopOffset.height + chatLift)
    }

    private func flameCenter(in geo: GeometryProxy) -> CGPoint {
        let wc = flameLayoutCenter()
        let o = geo.frame(in: .global).origin
        return CGPoint(x: wc.x - o.x, y: wc.y - o.y)
    }

    /// A finished carry (never a flick — the actor sends nil for those)
    /// becomes his new home, persisted in the flame settings.
    private func commitDrag(_ translation: CGSize?) {
        defer { dragStartCenter = nil }
        guard let translation, let start = dragStartCenter else { return }
        let placement = FlamePlacement(
            x: Double((start.x + translation.width) / screenSize.width),
            y: Double((start.y + translation.height) / screenSize.height))
        playStore.settings.placement = placement
        // Dragged while chatting: that's where he should stay on close.
        if showBubbleChat { returnPlacement = placement }
    }

    /// Quick hop: his limbs crouch, launch and land (see FlameActor's
    /// travel hops) while his center travels to `target` (window
    /// coordinates). Only `hopOffset` moves during the flight:
    /// placement and chatLift stay frozen exactly as they are, so the
    /// first animated frame is where he already sits by construction
    /// — there is no pin or swap that could shift him first (the
    /// previous pin-the-offset-while-swapping-placement approach
    /// still let him drop by the perch amount before departing when
    /// the keyboard was up). `arrive` performs the placement/lift
    /// swap on landing inside one no-animation transaction together
    /// with zeroing the offset; callers define it so the drawn
    /// position is identical on both sides of that swap.
    @State private var hopTask: Task<Void, Never>?
    private func hop(to target: CGPoint,
                     arrive: @escaping () -> Void,
                     then: @escaping () -> Void) {
        hopTask?.cancel()
        let start = flameWindowCenter()
        let layout = flameLayoutCenter()
        let liftAtStart = chatLift
        let placementAtStart = playStore.settings.placement
        let distance = hypot(target.x - start.x, target.y - start.y)
        var instant = Transaction()
        instant.disablesAnimations = true
        // One-instant landing shared by the short path and arrival:
        // swap placement/lift and zero the offset together. Skipped
        // (offset/lift simply zeroed) if the user grabbed him
        // mid-flight and committed a new placement of their own.
        let land = {
            // If he was grabbed and dropped mid-flight, the user's
            // own placement wins over this hop's destination.
            let grabbedMidFlight = playStore.settings.placement != placementAtStart
            withTransaction(instant) {
                if !grabbedMidFlight { arrive() }
                hopOffset = .zero
                if grabbedMidFlight && chatLift == liftAtStart { chatLift = 0 }
            }
            flameTraveling = false
        }
        if reduceMotion || distance < 8 {
            land()
            then()
            return
        }
        let duration = min(0.85, max(0.45, Double(distance) / 1400 + 0.35))
        // End offset that puts drawn == target with layout and lift
        // unchanged: drawn = layout + endOffset + (0, lift).
        let endOffset = CGSize(width: target.x - layout.x,
                               height: target.y - layout.y - liftAtStart)
        flameTraveling = true
        hopTask = Task { @MainActor in
            withAnimation(.easeInOut(duration: duration)) { hopOffset = endOffset }
            try? await Task.sleep(for: .seconds(duration))
            if Task.isCancelled { return }
            land()
            then()
        }
    }

    /// Tapped anywhere, he jumps down to his corner first; then the chat
    /// grows out of him as a speech bubble instead of a bottom sheet.
    private func flameTapped() {
        if showBubbleChat { closeBubble(); return }
        returnPlacement = playStore.settings.placement
        bubbleDragOffset = 0
        hop(to: windowCenter(for: nil),
            arrive: { playStore.settings.placement = nil }) {
            withAnimation(reduceMotion ? nil : .spring(response: 0.45, dampingFraction: 0.82)) {
                showBubbleChat = true
                chatLift = -chatLiftAmount
            }
        }
    }

    /// Closing sends him hopping back to wherever he was living before.
    private func closeBubble() {
        withAnimation(reduceMotion ? nil : .easeIn(duration: 0.2)) {
            showBubbleChat = false
        }
        guard let back = returnPlacement else {
            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.3)) {
                chatLift = 0
            }
            return
        }
        returnPlacement = nil
        // The hop travels with placement and perch lift frozen (see
        // hop), departing from exactly where he sits perched under
        // the bubble; the placement/lift swap happens on landing,
        // where drawn == target on both sides of it.
        hop(to: windowCenter(for: back),
            arrive: {
                playStore.settings.placement = back
                chatLift = 0
            }) {}
    }

    private func bubbleChat(in geo: GeometryProxy) -> some View {
        let size = geo.size
        let origin = geo.frame(in: .global).origin
        let width = min(screenSize.width - 24, 390)
        // Keyboard up: he stays exactly where he is (the keyboard covers
        // his corner); only the bubble shrinks to the space above it.
        let bubbleBottomWindow = keyboardHeight > 0
            ? screenSize.height - keyboardHeight - 8
            : screenSize.height - flameFrameH * 0.78 - 2
        let fullHeight = min(screenSize.height * 0.84,
                             max(280, bubbleBottomWindow - 56))
        // Grabber drag collapses from the top: position below is
        // derived from this height against the fixed bottom, so the
        // bottom (and tail, and composer) stay planted while the
        // top edge tracks the finger. Floored so the grabber and
        // composer never crush into each other mid-drag.
        let height = max(96, fullHeight - bubbleDragOffset)
        return ZStack {
            Color.clear
            VStack(alignment: .trailing, spacing: 0) {
                ZStack(alignment: .top) {
                    ConversationView(background: HyggeTheme.card, bubbleBackground: HyggeTheme.paper, showsHeader: false)
                    // Grabber: a wide hit strip across the top, not just
                    // the visible pill. It must outrank the transcript
                    // ScrollView directly underneath (plain .gesture
                    // loses to its pan recognizer, which made the
                    // handle feel dead). Dragging collapses the bubble
                    // (see height above); release past the threshold
                    // closes it, short of that it springs back open.
                    ZStack(alignment: .top) {
                        Color.clear
                        Capsule()
                            .fill(HyggeTheme.secondary.opacity(0.55))
                            .frame(width: 38, height: 5)
                            .padding(.top, 8)
                    }
                    .frame(width: 160, height: 32)
                    .contentShape(Rectangle())
                    .highPriorityGesture(
                        DragGesture(minimumDistance: 4)
                            .onChanged { value in
                                bubbleDragOffset = max(0, value.translation.height)
                            }
                            .onEnded { value in
                                if value.translation.height > 110
                                    || value.predictedEndTranslation.height > 220 {
                                    closeBubble()
                                } else {
                                    withAnimation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.85)) {
                                        bubbleDragOffset = 0
                                    }
                                }
                            }
                    )
                    .accessibilityElement()
                    .accessibilityLabel("Drag down to close chat")
                    .accessibilityIdentifier("chatBubbleGrabber")
                    .accessibilityAction(named: "Close chat") { closeBubble() }
                }
                .frame(width: width, height: height)
                .background(HyggeTheme.card, in: RoundedRectangle(cornerRadius: 26))
                .clipShape(RoundedRectangle(cornerRadius: 26))
                .overlay(RoundedRectangle(cornerRadius: 26)
                    .stroke(HyggeTheme.hairline, lineWidth: 1))
                .shadow(color: .black.opacity(0.28), radius: 24, y: 10)
                // The bubble's tail, reaching down toward him.
                Rectangle()
                    .fill(HyggeTheme.card)
                    .frame(width: 22, height: 22)
                    .rotationEffect(.degrees(45))
                    .padding(.trailing, 58)
                    .offset(y: -9)
            }
            // Bottom-anchored: center derives from the (possibly
            // collapsed) height against the fixed bottom, so a
            // grabber drag shrinks the bubble in place instead of
            // pushing the whole bubble down.
            .position(x: screenSize.width - width / 2 - 12 - origin.x,
                      y: bubbleBottomWindow - height / 2 - origin.y)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Chat with Hygge")
            .accessibilityIdentifier("chatBubble")
        }
        .frame(width: size.width, height: size.height)
        .transition(.asymmetric(
            insertion: .scale(scale: 0.55, anchor: .bottomTrailing).combined(with: .opacity),
            removal: .opacity))
        .zIndex(3)
    }

    private var flameState: FlameState {
        // The badge only promises what tapping him (the chat) can
        // resolve; feed decisions never strand it.
        if store.chatBadgeCount > 0 { return .needsYou(store.chatBadgeCount) }
        return store.isAgentWorking ? .working : .asleep
    }
    private var proposedSites: [ProposedSite] {
        FeedRankOrdering.sorted(store.proposals.filter { $0.status == .proposed }, rankScore: \.rankScore)
    }
    private var pendingProposals: [ProposedSite] { admitted(proposedSites) { "proposal-\($0.id)" } }
    private var availableListings: [Opportunity] {
        // Feed order is the server ranker's (Brief 06), through the
        // one consumer ordering — never a view-local comparator.
        FeedRankOrdering.sorted(
            store.opportunities.filter { !$0.isDemo && ($0.status == .new || $0.status == .saved) }
                .filter { opportunity in !store.applications.contains { $0.opportunityID == opportunity.id } },
            rankScore: \.rankScore) { $0.id == store.highlightedOpportunityID }
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
        let canInsert = isAtTop && focus == nil && !showConversation && !showProfile && !showNotifications
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--feed-arrivals-preview") { print("FEED_RECEIVE top=\(isAtTop) insert=\(canInsert) visible=\(updateGate.visibleIDs.count) latest=\(candidateIDs.count)") }
        #endif
        withAnimation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.45, dampingFraction: 0.88)) {
            updateGate.receive(candidateIDs, atTop: canInsert)
        }
    }
    private var isEmpty: Bool { pendingProposals.isEmpty && listings.isEmpty && decisionTasks.isEmpty && runningTasks.isEmpty && events.isEmpty && !store.isPaused && !store.plan.rested }
    /// Anything above the Journal heading. When this is false the
    /// feed is journal-only, so Earlier expands by default.
    private var hasActionableFeedItems: Bool {
        !runningTasks.isEmpty || !pendingProposals.isEmpty || !listings.isEmpty
            || !decisionTasks.filter { !isArchived(taskKey($0)) }.isEmpty
            || store.isPaused || store.plan.rested
            || (store.notificationPrimerVisible && updateGate.visibleIDs.contains("notifications"))
    }
    private func taskKey(_ task: AgentTask) -> String { FeedFocus.taskKey(task) }
    private func eventKey(_ event: ActivityEvent) -> String { "event-\(event.id)" }
    private func isArchived(_ id: String) -> Bool { store.archivedFeedIDs.contains(id) }

    private func proposalCard(_ proposal: ProposedSite) -> some View {
        card(id: "proposal-\(proposal.id)", title: store.siteName(id: proposal.siteID), subtitle: proposal.rationale,
             icon: "link", style: .invitation,
             siteDomain: store.siteDomain(id: proposal.siteID), siteName: store.siteName(id: proposal.siteID),
             chatContext: ChatContextRef(kind: "site", id: proposal.siteID,
                                         title: store.siteName(id: proposal.siteID), subtitle: proposal.rationale,
                                         siteID: proposal.siteID, siteDomain: store.siteDomain(id: proposal.siteID)),
             open: { openFocus(.proposal(proposal)) },
             dismiss: {
                store.dismissProposal(proposalID: proposal.id)
                showUndo("Suggestion dismissed", restoring: "proposal-\(proposal.id)") { store.undoSiteDismissal(proposalID: proposal.id) }
             })
    }
    private func opportunityCard(_ opportunity: Opportunity) -> some View {
        // A blocked-look item is not work: its card offers the fix
        // (in its detail), never an application draft.
        let blocked = opportunity.needsYouKind != nil
        return card(id: "opportunity-\(opportunity.id)", title: opportunity.title,
             subtitle: blocked ? store.siteName(id: opportunity.siteID)
                : "\(opportunity.payLabel) · \(opportunity.isRemote ? "Remote" : opportunity.locationLabel)",
             icon: blocked ? (opportunity.needsYouKind == "login" ? "key" : "hand.raised") : "sparkle",
             style: .opportunity,
             siteDomain: store.siteDomain(id: opportunity.siteID), siteName: store.siteName(id: opportunity.siteID),
             chatContext: ChatContextRef(kind: "opportunity", id: opportunity.id.uuidString,
                                         title: opportunity.title,
                                         subtitle: "\(store.siteName(id: opportunity.siteID)) · \(opportunity.payLabel)",
                                         siteID: opportunity.siteID, siteDomain: store.siteDomain(id: opportunity.siteID)),
             open: { openFocus(.opportunity(opportunity)) },
             dismiss: {
                store.setStatus(.dismissed, for: opportunity.id)
                showUndo("Opportunity dismissed", restoring: "opportunity-\(opportunity.id)") { store.setStatus(opportunity.status, for: opportunity.id) }
             })
    }
    @ViewBuilder private func activeTaskCard(_ task: AgentTask) -> some View {
        if task.browserSessionID != nil {
            SwipeFeedCard(id: taskKey(task), openCardID: $openCardID, open: { openActiveTask(task) }, chat: { chatAboutTask(task) }, dismiss: {}, allowsDismissal: false) {
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
                 icon: "sparkles",
                 chatContext: taskChatContext(task),
                 open: { openFocus(.task(task)) }, allowsDismissal: false)
        }
    }
    private func taskCard(_ task: AgentTask) -> some View {
        let chat = task.needsChatHelp
        let approval = task.help?.kind == .approval
        return card(id: taskKey(task), title: taskTitle(task),
                    subtitle: store.siteName(id: task.siteID), icon: taskIcon(task), usesProfilePhoto: task.kind == .buildProfile, style: chat && !approval ? .question : .review,
                    siteDomain: chat && !approval ? nil : store.siteDomain(id: task.siteID), siteName: store.siteName(id: task.siteID),
                    chatContext: taskChatContext(task),
                    open: { if chat { openChat(task) } else { openFocus(.task(task)) } },
                    chatOverride: chat ? { openChat(task) } : nil)
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
        if store.isPaused {
            rows.append(.paused)
        } else if store.plan.rested {
            // Free is resting: say so where the paused card sits.
            // What is already under way still shows below.
            rows.append(.planRested)
            rows += decisionTasks.filter { !isArchived(taskKey($0)) }.map(FeedRow.decision)
        } else {
            rows += pendingProposals.prefix(moreSites ? pendingProposals.count : 1).map(FeedRow.proposal)
            if pendingProposals.count > 1 { rows.append(.moreSites) }
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
                FeedSummary(title: "Hygge is paused", subtitle: "Everything is here when you’re ready", icon: "pause")
            }.buttonStyle(.plain)
        case .planRested:
            PlanLimitCardView(state: PlanUsageState(store.plan, renewsAt: store.plusStore.expiresAt),
                              onSeePlus: { showPlus = true })
        case .moreSites:
            Button(moreSites ? "Fewer suggestions" : "\(pendingProposals.count - 1) more job sites") { withAnimation { moreSites.toggle() } }
                .font(.caption.weight(.medium)).foregroundStyle(HyggeTheme.sageDeep).frame(minHeight: 44)
        case .notifications:
            card(id: "notifications", title: "A heads-up when you need it", subtitle: "New work and things that need your OK", icon: "bell",
                 chatContext: ChatContextRef(kind: "notifications", id: "notifications", title: "A heads-up when you need it", subtitle: "New work and things that need your OK"),
                 open: { showNotifications = true }, dismiss: {
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
    @ViewBuilder private func eventCard(_ event: ActivityEvent) -> some View {
        if event.kind == .filedEmail, let mail = store.filedEmailSummaries.first(where: { $0.id.lowercased() == event.id.uuidString.lowercased() }) {
            SwipeFeedCard(id: eventKey(event), openCardID: $openCardID,
                          open: { openCardID = nil; openFocus(.event(event)) },
                          chat: { chatAbout(ChatContextRef(kind: "mail", id: mail.id, title: mail.displayTitle, subtitle: mail.senderAddress, siteID: mail.siteID, siteDomain: mail.senderDomain)) },
                          dismiss: { archive(eventKey(event)) }) { EmailFeedCard(mail: mail) }
                .matchedGeometryEffect(id: eventKey(event), in: focusAnimation, isSource: focus?.id != eventKey(event))
                .opacity(focus?.id == eventKey(event) ? 0 : 1)
        } else {
        card(id: eventKey(event), title: FeedEventPresentation.title(event),
             subtitle: event.siteID.map { store.siteName(id: $0) } ?? JournalBuilder.dayLabel(for: event.occurredAt),
             icon: FeedEventPresentation.icon(event), asset: event.kind == .workCompleted ? "SettingsEarnings" : nil, style: event.kind == .workCompleted ? eventStyle(event) : .update,
             chatContext: ChatContextRef(kind: "event", id: "\(event.id)",
                                         title: FeedEventPresentation.title(event),
                                         subtitle: event.siteID.map { store.siteName(id: $0) } ?? JournalBuilder.dayLabel(for: event.occurredAt),
                                         siteID: event.siteID, siteDomain: event.siteID.flatMap { store.siteDomain(id: $0) }),
             open: { openFocus(.event(event)) })
        }
    }
    private func card(id: String, title: String, subtitle: String, icon: String, asset: String? = nil, usesProfilePhoto: Bool = false, style: FeedCardStyle = .update,
                      siteDomain: String? = nil, siteName: String? = nil,
                      chatContext: ChatContextRef, open: @escaping () -> Void,
                      chatOverride: (() -> Void)? = nil, dismiss: (() -> Void)? = nil, allowsDismissal: Bool = true) -> some View {
        SwipeFeedCard(id: id, openCardID: $openCardID,
                      open: { openCardID = nil; open() },
                      chat: { openCardID = nil; if let chatOverride { chatOverride() } else { chatAbout(chatContext) } },
                      dismiss: dismiss ?? { archive(id) }, allowsDismissal: allowsDismissal) {
            FeedVisualCard(style: style, title: title, subtitle: subtitle, icon: icon, asset: asset, usesProfilePhoto: usesProfilePhoto,
                           siteDomain: siteDomain, siteName: siteName)
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
    private func dismissPresented() {
        showConversation = false
        showProfile = false
        showNotifications = false
        if showBubbleChat { closeBubble() }
        if focus != nil { closeFocus() }
    }
    /// Right swipe on any card: open the chat with that card
    /// attached, so the next message is understood to be about it.
    private func chatAbout(_ context: ChatContextRef) {
        store.pendingChatContext = context
        if !showBubbleChat { flameTapped() }
    }
    private func taskChatContext(_ task: AgentTask) -> ChatContextRef {
        ChatContextRef(kind: "task", id: task.id.uuidString,
                       title: taskTitle(task), subtitle: store.siteName(id: task.siteID),
                       siteID: task.siteID, siteDomain: store.siteDomain(id: task.siteID))
    }
    private func chatAboutTask(_ task: AgentTask) {
        // A task already waiting on a chat answer keeps its
        // dedicated reply flow; anything else is a normal
        // conversation about the task.
        if task.needsChatHelp { openChat(task) } else { chatAbout(taskChatContext(task)) }
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
        case .event(let event):
            if event.kind == .filedEmail, let mail = store.filedEmailSummaries.first(where: { $0.id.lowercased() == event.id.uuidString.lowercased() }) {
                FiledEmailDetailView(mail: mail, isFeedCard: true)
            } else { FeedEventDetail(event: event) }
        case .task(let task): FeedTaskReview(close: { closeFocus() }, taskID: task.id)
        case .browser(let task): CloudBrowserView(urlString: task.targetURLString, existingSessionID: task.browserSessionID, taskID: task.id, onClose: { closeFocus() })
        case .paused:
            FeedDetailContent {
                Text("Hygge is paused").font(.title2.bold()).foregroundStyle(HyggeTheme.ink)
                    .feedCardDismissRegion()
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
    case paused, planRested, moreSites, notifications, journal, earlier
    var id: String {
        switch self {
        case .active(let task), .decision(let task): return FeedFocus.taskKey(task)
        case .proposal(let value): return "proposal-\(value.id)"
        case .opportunity(let value): return "opportunity-\(value.id)"
        case .event(let value): return "event-\(value.id)"
        case .paused: return "paused"
        case .planRested: return "plan-rested"
        case .moreSites: return "more-sites"
        case .notifications: return "notifications"
        case .journal: return "journal-heading"
        case .earlier: return "earlier"
        }
    }
}
