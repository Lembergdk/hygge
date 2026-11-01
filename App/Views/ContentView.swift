import SwiftUI

/// Root: first launch shows the intro carousel once, then sign-in,
/// then the conversational onboarding; after that, the one Home feed.
/// There is deliberately no tab bar anywhere in Hygge.
struct ContentView: View {
    @Environment(AppStore.self) private var store
    @AppStorage("hasSeenIntroCarousel") private var hasSeenCarousel = false
    @State private var authDestination: AuthDestination = .signup

    var body: some View {
        // Carousel -> sign-in (Brief 00). Release requires a real
        // session (requireCloud); Debug keeps its developer shortcut.
        // Integration note: the IntroCarouselView/AuthDestination
        // contract is preserved — only this routing consumes it.
        switch AuthGate.resolve(hasSeenCarousel: hasSeenCarousel,
                                hasOnboarded: store.hasOnboarded,
                                isSignedIn: store.isSignedIn,
                                authRequired: BackendClient.requireCloud) {
        case .carousel:
            IntroCarouselView { destination in
                authDestination = destination
                hasSeenCarousel = true
            }
        case .auth:
            AuthView(destination: authDestination) {
                store.refreshAuthState()
            }
        case .onboarding:
            OnboardingView()
        case .home:
            NavigationStack {
                HomeFeedView()
            }
        }
    }
}
