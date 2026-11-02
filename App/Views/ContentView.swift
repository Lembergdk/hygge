import SwiftUI

/// Root: first launch shows the intro carousel once, then the
/// onboarding conversation — sign-in is its final step, not a page
/// before it. After that, the one Home feed. There is deliberately
/// no tab bar anywhere in Hygge.
struct ContentView: View {
    @Environment(AppStore.self) private var store
    @AppStorage(AppStore.introCarouselSeenKey) private var hasSeenCarousel = false

    var body: some View {
        switch AuthGate.resolve(hasSeenCarousel: hasSeenCarousel,
                                hasOnboarded: store.hasOnboarded,
                                isSignedIn: store.isSignedIn,
                                authRequired: BackendClient.requireCloud,
                                wantsSignIn: store.wantsSignIn) {
        case .carousel:
            IntroCarouselView { destination in
                if destination == .signIn { store.wantsSignIn = true }
                hasSeenCarousel = true
            }
        case .signIn:
            // The minimal log in page (carousel "Log in", or a
            // signed-out returning user).
            LoginView()
        case .onboarding:
            OnboardingView()
        case .home:
            NavigationStack {
                HomeFeedView()
            }
        }
    }
}
