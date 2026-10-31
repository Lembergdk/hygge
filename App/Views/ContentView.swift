import SwiftUI

/// Root: first run is the conversation; after that, the one Home feed.
/// There is deliberately no tab bar anywhere in Hygge.
struct ContentView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        if !store.hasOnboarded {
            OnboardingView()
        } else {
            NavigationStack {
                HomeFeedView()
            }
        }
    }
}
