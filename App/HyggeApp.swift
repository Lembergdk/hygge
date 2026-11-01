import SwiftUI

@main
struct HyggeApp: App {
    @State private var store = AppStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(store)
                // Brief 01: pull (or migrate once) at launch, and pull
                // again whenever the app comes back to the front. The
                // cache renders instantly either way.
                .task { await store.syncOnLaunch() }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active {
                        Task { await store.pullFromServer() }
                    }
                }
        }
    }
}
