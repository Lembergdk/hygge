import SwiftUI

/// Interactive view of a server-side cloud browser session (Cloudflare Browser
/// Run / Playwright worker via the agent service). You can watch the agent,
/// tap elements yourself, type, and take over or hand back control. When the
/// service is unreachable, show recovery instead of an interactive fake page.
struct CloudBrowserView: View {
    @Environment(AppStore.self) private var store
    let urlString: String
    /// When set, show this already-open session (a paused sign-in
    /// check) instead of starting a fresh one.
    var existingSessionID: String? = nil
    @State private var snapshot: BrowserSessionSnapshot?
    @State private var failure: String?
    @State private var typeText = ""
    @State private var busy = false
    @State private var countedLiveSession = false

    var body: some View {
        VStack(spacing: 0) {
            statusBanner
            if let failure {
                ContentUnavailableView {
                    Label("Couldn’t open this step", systemImage: "wifi.exclamationmark")
                } description: { Text(failure) } actions: {
                    Button("Try again") { Task { await start() } }
                }
            } else if let snapshot {
                sessionBody(snapshot)
            } else {
                ProgressView("Opening the page for you…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task { await start() }
        .onDisappear {
            if countedLiveSession { store.noteBrowserSessionClosed(); countedLiveSession = false }
        }
    }

    private var statusBanner: some View {
        Text("Finish the site’s check here, then continue setup. Hygge will check the result before carrying on.")
            .font(.footnote)
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(HyggeTheme.sageTint)
    }

    private func sessionBody(_ snapshot: BrowserSessionSnapshot) -> some View {
        VStack(spacing: 8) {
            Text(snapshot.currentURLString).font(.caption).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let base64 = snapshot.screenshotBase64, let data = Data(base64Encoded: base64),
               let image = UIImage(data: data) {
                Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 320)
            }
            HStack(spacing: 10) {
                if !snapshot.humanControlled {
                    AnimatedFlame(animation: .laptop, size: 40)
                }
                Text(snapshot.humanControlled ? "You are driving this session." : "Hygge is driving. Take over any time.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            List {
                Section("Page elements — tap to act") {
                    ForEach(snapshot.elements) { element in
                        Button {
                            Task { await act(action: element.kind.rawValue, target: element.label, value: typeText.isEmpty ? nil : typeText) }
                        } label: {
                            Label(element.label, systemImage: element.kind == .type ? "keyboard" : "hand.tap")
                        }
                    }
                }
            }
            HStack {
                TextField("Text to type", text: $typeText)
                    .textFieldStyle(.roundedBorder)
                Button(snapshot.humanControlled ? "Hand back to agent" : "Take over") {
                    Task { await act(action: "setHumanControl", target: nil, value: snapshot.humanControlled ? "false" : "true") }
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy)
            }
            .padding(8)
        }
        .padding(.horizontal, 8)
    }

    private func start() async {
        failure = nil
        if let existingSessionID {
            guard let live = try? await store.backend.sessionSnapshot(sessionID: existingSessionID) else {
                failure = "Your saved page couldn't be reached. Try again, or return to chat and continue setup to reopen sign-in."
                return
            }
            snapshot = live
        } else {
            guard let live = try? await store.backend.createSession(url: urlString) else {
                failure = "The site couldn't open. Your progress is saved; try again when you're connected."
                return
            }
            snapshot = live
        }
        if !countedLiveSession {
            countedLiveSession = true
            store.noteBrowserSessionOpened()
        }
    }

    private func act(action: String, target: String?, value: String?) async {
        guard let snapshot else { return }
        busy = true
        defer { busy = false }
        if let next = try? await store.backend.act(sessionID: snapshot.sessionID, action: action, target: target, value: value) {
            self.snapshot = next
            typeText = ""
        } else {
            failure = "That action didn’t finish. Reopen this step to check the page before continuing."
        }
    }
}
