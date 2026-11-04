import SwiftUI

struct BrowserLiveViewport: View {
    @Environment(\.scenePhase) private var scenePhase
    var session: LiveBrowserSession
    var interactive = false
    var showsRecoveryActions = false
    var revealControls: (() -> Void)?
    var body: some View {
        ZStack {
            HyggeTheme.paperDeep
            if !interactive, let image = session.image {
                GeometryReader { geometry in
                    Image(uiImage: image).resizable().scaledToFill()
                        .frame(width: geometry.size.width, height: geometry.size.height, alignment: .top).clipped()
                }.opacity(session.connected ? 1 : 0.3)
            } else {
                RemoteBrowserCanvas(session: session, image: session.image, viewport: session.viewport, pointer: session.pointer, keyboardVisible: session.keyboardVisible, interactive: interactive, revealControls: revealControls)
                    .opacity(session.connected ? 1 : 0.3)
            }
            if !session.connected {
                VStack(spacing: 12) {
                    if session.isRecovering { ProgressView().tint(HyggeTheme.sageDeep) }
                    Text(session.status).font(.subheadline.weight(.medium))
                    if session.ended { Text("This session is no longer available.").font(.caption) }
                    else if session.requiresSignIn { Text("Sign in to Hygge again.").font(.caption) }
                    else if session.retryStopped {
                        if showsRecoveryActions {
                            Button("Reconnect") { session.reconnect() }.font(.subheadline.weight(.semibold))
                        } else { Text(interactive ? "Try reconnecting below." : "Tap to reconnect.").font(.caption) }
                    }
                }.foregroundStyle(HyggeTheme.ink).padding(20)
                    .background(HyggeTheme.paper.opacity(0.95), in: RoundedRectangle(cornerRadius: 18))
            }
        }
        .clipped()
        .task { await session.watch() }
        .onChange(of: scenePhase) { _, phase in session.setForeground(phase == .active) }
    }
}

struct BrowserLiveAttachment: View {
    @Environment(AppStore.self) private var store
    let task: AgentTask
    var open: () -> Void
    var body: some View {
        if let id = task.browserSessionID {
            let session = store.browserSession(id)
            Button(action: open) {
                VStack(spacing: 0) {
                    BrowserLiveViewport(session: session)
                        .aspectRatio(1.6, contentMode: .fit)
                        .allowsHitTesting(false)
                    HStack(spacing: 6) {
                        Circle().fill(session.connected ? HyggeTheme.sageDeep : HyggeTheme.secondary).frame(width: 7, height: 7)
                        Text("\(store.siteName(id: task.siteID)) · \(session.status)").font(.caption)
                        Spacer()
                        Image(systemName: "arrow.up.left.and.arrow.down.right").font(.caption)
                    }.foregroundStyle(HyggeTheme.ink).padding(12)
                }.background(HyggeTheme.card).clipShape(RoundedRectangle(cornerRadius: 18))
            }.buttonStyle(.plain).accessibilityLabel("Watch \(store.siteName(id: task.siteID)) browser")
        }
    }
}

struct CloudBrowserView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(FeedCardDismissal.self) private var cardDismissal: FeedCardDismissal?
    let urlString: String
    var existingSessionID: String? = nil
    var taskID: UUID? = nil
    var takeControlOnOpen = false
    var onClose: (() -> Void)? = nil
    @State private var fullscreen = false
    @State private var autoControlAttempted = false
    private var task: AgentTask? { store.tasks.first { $0.id == taskID } }
    private var sessionID: String? { if let task { return task.browserSessionID }; return existingSessionID }
    private var title: String { task.map { store.siteName(id: $0.siteID) } ?? URL(string: urlString)?.host ?? "Browser" }
    private func statusText(_ session: LiveBrowserSession) -> String {
        session.ended ? "Browser session ended"
            : session.requiresSignIn ? "Sign in to continue"
            : session.retryStopped ? "Browser unavailable"
            : session.ownsControl ? "You’re in control"
            : session.humanControlled ? "Waiting for you"
            : task?.needsChatHelp == true ? "Hygge needs you" : "Hygge is working"
    }

    var body: some View {
        Group {
            if cardDismissal != nil {
                ViewThatFits(in: .vertical) {
                    browserContent.fixedSize(horizontal: false, vertical: true)
                    ScrollView { browserContent }
                        .scrollBounceBehavior(.basedOnSize, axes: .vertical)
                }
            } else {
                browserContent.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(HyggeTheme.paper.ignoresSafeArea())
        .foregroundStyle(HyggeTheme.ink)
        .tint(HyggeTheme.sageDeep)
        .presentationDragIndicator(.visible)
        .toolbar(.hidden, for: .navigationBar)
        .task { await store.observeBrowserTasks() }
    }
    @ViewBuilder private var browserContent: some View {
        if let id = sessionID {
            let session = store.browserSession(id)
            VStack(spacing: 12) {
                // One merged bar replaces the old site row + status
                // row (+ host caption): the site is named once, the
                // status said once, and the ~110 pt reclaimed goes
                // to the viewport. At accessibility sizes the
                // title/status stack instead of truncating.
                HStack(alignment: .center, spacing: 10) {
                    AnimatedFlame(animation: session.ended || session.retryStopped || session.requiresSignIn || session.humanControlled || task?.needsChatHelp == true ? .notify : .laptop, size: 24)
                        .accessibilityHidden(true)
                    Group {
                        if dynamicTypeSize.isAccessibilitySize {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(title).font(.headline).lineLimit(1)
                                Text(statusText(session)).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        } else {
                            (Text(title).font(.headline)
                             + Text(" · ").font(.subheadline).foregroundColor(HyggeTheme.secondary)
                             + Text(statusText(session)).font(.subheadline).foregroundColor(HyggeTheme.secondary))
                                .lineLimit(1)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityElement(children: .combine)
                    .feedCardDismissRegion()
                    Circle().fill(session.connected ? HyggeTheme.sageDeep : HyggeTheme.secondary).frame(width: 7, height: 7)
                        .accessibilityLabel(session.connected ? "Connected" : "Not connected")
                    // The word only earns its space when unhealthy;
                    // dot + status sentence already say "live".
                    if !session.connected || session.isRecovering {
                        Text(session.status).font(.caption).foregroundStyle(HyggeTheme.secondary)
                    }
                    Button { fullscreen = true } label: { Image(systemName: "arrow.up.left.and.arrow.down.right").frame(width: 44, height: 44) }
                        .accessibilityLabel("Fullscreen browser")
                }
                feedViewport(session)
                    .clipShape(RoundedRectangle(cornerRadius: 20))
                    .overlay { GeometryReader { geometry in
                        Color.clear.task(id: "\(geometry.size)-\(session.connected)-\(session.ownsControl)-\(fullscreen)") { if !fullscreen { session.resize(geometry.size) } }
                    }.allowsHitTesting(false) }
                if let problem = session.problem {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(problem).font(.footnote)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if session.canReconnect {
                            Button("Reconnect") { session.reconnect() }.font(.footnote.weight(.semibold))
                        } else {
                            Button("Back to chat") { openChat() }.font(.footnote.weight(.semibold))
                        }
                    }.foregroundStyle(HyggeTheme.secondary)
                }
                if !session.keyboardVisible && (session.connected || session.isRecovering) { controls(session) }
            }.padding(.horizontal, 18).padding(.top, 10).padding(.bottom, 12)
                .task(id: session.connected) {
                    if session.connected && takeControlOnOpen && !autoControlAttempted {
                        autoControlAttempted = true
                        _ = await session.takeControl()
                    }
                }
                .fullScreenCover(isPresented: $fullscreen) {
                    BrowserFullscreen(session: session, resume: { await resume(session) })
                }
        } else {
            VStack(spacing: 16) {
                AnimatedFlame(animation: task?.needsChatHelp == true ? .notify : .laptop, size: 68)
                if let task, task.needsChatHelp, let help = task.help, help.kind == .recovery {
                    Text(help.message).multilineTextAlignment(.center).feedCardDismissRegion()
                    Button(help.actionLabel) {
                        Task { await store.replyToTask(taskID: task.id, helpID: help.id, choiceLabel: help.actionLabel) }
                    }.buttonStyle(SettingsActionStyle())
                    Button("Stop this task") {
                        Task { await store.declineTaskHelp(taskID: task.id, helpID: help.id, choiceLabel: "Stop this task"); openChat() }
                    }.buttonStyle(SettingsActionStyle(filled: false))
                } else {
                    Text(task?.status == .succeeded || task?.status == .rejected ? "This session has finished." : "Connecting to \(title)…")
                        .feedCardDismissRegion()
                }
                Button("Back to chat") { openChat() }.buttonStyle(SettingsActionStyle(filled: false))
            }.padding(24)
        }
    }
    @ViewBuilder private func feedViewport(_ session: LiveBrowserSession) -> some View {
        if cardDismissal != nil {
            BrowserLiveViewport(session: session, interactive: !fullscreen)
                .aspectRatio(session.viewport.width / max(session.viewport.height, 1), contentMode: .fit)
        } else {
            BrowserLiveViewport(session: session, interactive: !fullscreen)
        }
    }
    private func controls(_ session: LiveBrowserSession) -> some View {
        HStack(spacing: 10) {
            if session.ownsControl {
                Button { session.precisionPointer.toggle() } label: { Image(systemName: "cursorarrow.motionlines").frame(width: 44, height: 48) }
                    .background(session.precisionPointer ? HyggeTheme.sageTint : HyggeTheme.card, in: RoundedRectangle(cornerRadius: 14))
                    .accessibilityLabel("Precision cursor").accessibilityValue(session.precisionPointer ? "On" : "Off")
                Button { session.keyboardVisible.toggle() } label: { Image(systemName: "keyboard").frame(width: 44, height: 48) }
                    .background(HyggeTheme.card, in: RoundedRectangle(cornerRadius: 14)).accessibilityLabel("Show keyboard")
            }
            Button {
                Task { if session.ownsControl { await resume(session) } else { _ = await session.takeControl() } }
            } label: {
                if session.busy { ProgressView().frame(maxWidth: .infinity) }
                else { Label(session.ownsControl ? "Let Hygge continue" : "Take control", systemImage: session.ownsControl ? "arrow.turn.up.right" : "cursorarrow")
                    .frame(maxWidth: .infinity) }
            }.buttonStyle(SettingsActionStyle()).disabled(!session.connected || session.busy)
            if !session.ownsControl {
                Button { openChat() } label: { Image(systemName: "bubble.left").frame(width: 44, height: 48) }
                    .background(HyggeTheme.card, in: RoundedRectangle(cornerRadius: 14)).accessibilityLabel("Back to chat")
            }
        }
    }
    private func close() { if let onClose { onClose() } else { dismiss() } }
    private func openChat() { if let taskID { store.conversationTaskID = taskID }; close() }
    private func resume(_ session: LiveBrowserSession) async {
        guard await session.handBack() else { return }
        if let taskID { store.browserDidResume(taskID) }
        fullscreen = false
        close()
    }
}

private struct BrowserFullscreen: View {
    @Environment(\.dismiss) private var dismiss
    let session: LiveBrowserSession
    var resume: () async -> Void
    @State private var showingControls = true
    @State private var hideTask: Task<Void, Never>?
    var body: some View {
        GeometryReader { geometry in
          ZStack(alignment: .bottom) {
            BrowserLiveViewport(session: session, interactive: true, showsRecoveryActions: true, revealControls: reveal)
                .frame(width: geometry.size.width, height: geometry.size.height)
                .task(id: "\(geometry.size)-\(session.connected)-\(session.ownsControl)") { session.resize(geometry.size) }
            if (showingControls || !session.connected) && !session.keyboardVisible {
                HStack(spacing: 12) {
                    if session.ownsControl {
                        Button { session.precisionPointer.toggle(); reveal() } label: { Image(systemName: "cursorarrow.motionlines") }.accessibilityLabel("Precision cursor")
                        Button { session.keyboardVisible = true } label: { Image(systemName: "keyboard") }.accessibilityLabel("Show keyboard")
                    }
                    Button {
                        Task { if session.ownsControl { await resume() } else { _ = await session.takeControl(); reveal() } }
                    } label: { Label(session.ownsControl ? "Let Hygge continue" : "Take control", systemImage: "cursorarrow") }
                        .font(.subheadline.weight(.semibold)).padding(.horizontal, 14).padding(.vertical, 12)
                        .background(HyggeTheme.sageDeep, in: Capsule()).foregroundStyle(HyggeTheme.onSage)
                        .disabled(!session.connected || session.busy)
                    Button { dismiss() } label: { Image(systemName: "arrow.down.right.and.arrow.up.left") }.accessibilityLabel("Exit fullscreen")
                }.buttonStyle(.plain).foregroundStyle(HyggeTheme.ink)
                    .padding(14).background(HyggeTheme.paper, in: Capsule()).padding(12)
            }
        }
          }
        .ignoresSafeArea(edges: session.keyboardVisible ? [] : .all)
        .background(.black).statusBarHidden().persistentSystemOverlays(.hidden)
        .onAppear(perform: reveal).onDisappear { hideTask?.cancel() }
    }
    private func reveal() {
        showingControls = true; hideTask?.cancel()
        guard !UIAccessibility.isVoiceOverRunning else { return }
        hideTask = Task {
            do { try await Task.sleep(for: .seconds(4)) } catch { return }
            withAnimation { showingControls = false }
        }
    }
}
