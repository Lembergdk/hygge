import SwiftUI

@main
struct HyggeApp: App {
    // Brief 07: captures the push token and notification taps; the
    // store drains them (PushService.swift). Permission is asked
    // from the Home primer, never from here.
    @UIApplicationDelegateAdaptor(HyggeAppDelegate.self) private var appDelegate
    @State private var store = AppStore()
    @State private var flamePlay = FlamePlayStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(store)
                .environment(flamePlay)
                // Brief 01: pull (or migrate once) at launch, and pull
                // again whenever the app comes back to the front. The
                // cache renders instantly either way. Push arrivals
                // (token / tapped route) drain right after the pull.
                .task {
                    #if DEBUG
                    guard !ProcessInfo.processInfo.arguments.contains("--settings-preview") else { return }
                    #endif
                    await store.syncOnLaunch()
                    await store.refreshPushState()
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active {
                        Task {
                            #if DEBUG
                            guard !ProcessInfo.processInfo.arguments.contains("--settings-preview") else { return }
                            #endif
                            guard !store.isCompletingSignIn else { return }
                            await store.pullFromServer()
                            await store.refreshPushState()
                        }
                    }
                }
                // The workspace stays warm as long as the app is open: a
                // beat every minute while foregrounded, on every screen —
                // not just the feed/chat/browser polls. sendKeepaliveIfDue
                // throttles to one a minute across all callers, so this
                // never double-fires with the poll. The task restarts
                // whenever the phase changes, so backgrounding cancels it.
                .task(id: scenePhase) {
                    guard scenePhase == .active else { return }
                    while !Task.isCancelled {
                        await store.sendKeepaliveIfDue()
                        do { try await Task.sleep(for: .seconds(60)) } catch { return }
                    }
                }
                // Magic links: hygge:// from the landing page, and the
                // https universal link when associated domains open
                // the app directly. The sign-in step consumes them.
                .onOpenURL { url in
                    _ = store.handleMagicURL(url)
                }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL {
                        _ = store.handleMagicURL(url)
                    }
                }
        }
    }
}
