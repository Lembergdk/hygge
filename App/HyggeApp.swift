import SwiftUI

@main
struct HyggeApp: App {
    // Brief 07: captures the push token and notification taps; the
    // store drains them (PushService.swift). Permission is asked
    // from the Home primer, never from here.
    @UIApplicationDelegateAdaptor(HyggeAppDelegate.self) private var appDelegate
    @State private var store = AppStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(store)
                // Brief 01: pull (or migrate once) at launch, and pull
                // again whenever the app comes back to the front. The
                // cache renders instantly either way. Push arrivals
                // (token / tapped route) drain right after the pull.
                .task {
                    await store.syncOnLaunch()
                    await store.refreshPushState()
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active {
                        Task {
                            await store.pullFromServer()
                            await store.refreshPushState()
                        }
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
