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
    let urlString: String
    var existingSessionID: String? = nil
    var taskID: UUID? = nil
    var takeControlOnOpen = false
    @State private var fullscreen = false
    @State private var autoControlAttempted = false
    private var task: AgentTask? { store.tasks.first { $0.id == taskID } }
    private var sessionID: String? { if let task { return task.browserSessionID }; return existingSessionID }
    private var title: String { task.map { store.siteName(id: $0.siteID) } ?? URL(string: urlString)?.host ?? "Browser" }

    var body: some View {
        ZStack {
            HyggeTheme.paper.ignoresSafeArea()
            if let id = sessionID {
                let session = store.browserSession(id)
                VStack(spacing: 16) {
                    HStack(spacing: 12) {
                        Image(systemName: "globe").font(.title3).foregroundStyle(HyggeTheme.sageDeep)
                            .frame(width: 40, height: 40).background(HyggeTheme.sageTint, in: RoundedRectangle(cornerRadius: 12))
                        VStack(alignment: .leading, spacing: 3) {
                            Text(title).font(.headline)
                            Text(URL(string: session.pageURL.isEmpty ? urlString : session.pageURL)?.host ?? "")
                                .font(.caption).foregroundStyle(HyggeTheme.secondary).lineLimit(1)
                        }
                        Spacer()
                        Button { fullscreen = true } label: { Image(systemName: "arrow.up.left.and.arrow.down.right").frame(width: 44, height: 44) }
                            .accessibilityLabel("Fullscreen browser")
                    }
                    HStack(spacing: 10) {
                        AnimatedFlame(animation: session.ended || session.retryStopped || session.requiresSignIn || session.humanControlled || task?.needsChatHelp == true ? .notify : .laptop, size: 36)
                        Text(session.ended ? "Browser session ended" : session.requiresSignIn ? "Sign in to continue" : session.retryStopped ? "Browser unavailable" : session.ownsControl ? "You’re in control" : session.humanControlled ? "Waiting for you" : task?.needsChatHelp == true ? "Hygge needs you" : "Hygge is working")
                            .font(.subheadline.weight(.semibold))
                        Spacer()
                        Circle().fill(session.connected ? HyggeTheme.sageDeep : HyggeTheme.secondary).frame(width: 7, height: 7)
                        Text(session.status).font(.caption).foregroundStyle(HyggeTheme.secondary)
                    }
                    BrowserLiveViewport(session: session, interactive: !fullscreen)
                        .clipShape(RoundedRectangle(cornerRadius: 20))
                        .overlay { GeometryReader { geometry in
                            Color.clear.task(id: "\(geometry.size)-\(session.connected)-\(session.ownsControl)-\(fullscreen)") { if !fullscreen { session.resize(geometry.size) } }
                        }.allowsHitTesting(false) }
                    if let problem = session.problem {
                        HStack {
                            Text(problem).font(.footnote)
                            if session.canReconnect {
                                Button("Reconnect") { session.reconnect() }.font(.footnote.weight(.semibold))
                            } else {
                                Button("Back to chat") { openChat() }.font(.footnote.weight(.semibold))
                            }
                        }.foregroundStyle(HyggeTheme.secondary)
                    }
                    if !session.keyboardVisible && (session.connected || session.isRecovering) { controls(session) }
                }.padding(.horizontal, 18).padding(.top, 22).padding(.bottom, 12)
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
                        Text(help.message).multilineTextAlignment(.center)
                        Button(help.actionLabel) {
                            Task { await store.replyToTask(taskID: task.id, helpID: help.id) }
                        }.buttonStyle(SettingsActionStyle())
                        Button("Stop this task") {
                            Task { await store.declineTaskHelp(taskID: task.id, helpID: help.id); openChat() }
                        }.buttonStyle(SettingsActionStyle(filled: false))
                    } else {
                        Text(task?.status == .succeeded || task?.status == .rejected ? "This session has finished." : "Connecting to \(title)…")
                    }
                    Button("Back to chat") { openChat() }.buttonStyle(SettingsActionStyle(filled: false))
                }.padding(24)
            }
        }
        .foregroundStyle(HyggeTheme.ink)
        .tint(HyggeTheme.sageDeep)
        .presentationDragIndicator(.visible)
        .toolbar(.hidden, for: .navigationBar)
        .task { await store.observeBrowserTasks() }
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
    private func openChat() { if let taskID { store.conversationTaskID = taskID }; dismiss() }
    private func resume(_ session: LiveBrowserSession) async {
        guard await session.handBack() else { return }
        if let taskID { store.browserDidResume(taskID) }
        fullscreen = false
        dismiss()
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
