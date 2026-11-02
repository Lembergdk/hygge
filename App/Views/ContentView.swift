import SwiftUI

/// Root routing (see AuthGate): brand-new people get the intro
/// carousel, then the onboarding conversation with sign-in as
/// its final step. Anyone who has signed in on this phone
/// before lands on the log in page when signed out. After
/// onboarding, the one Home feed. There is deliberately no tab
/// bar anywhere in Hygge.
struct ContentView: View {
    @Environment(AppStore.self) private var store
    /// This launch only: the carousel was finished or passed.
    @State private var introDone = false

    var body: some View {
        switch AuthGate.resolve(introDone: introDone,
                                hasOnboarded: store.hasOnboarded,
                                isSignedIn: store.isSignedIn,
                                authRequired: BackendClient.requireCloud,
                                wantsSignIn: store.wantsSignIn,
                                hasSignedInBefore: store.hasSignedInBefore,
                                wantsOnboarding: store.wantsOnboarding) {
        case .carousel:
            IntroCarouselView { destination in
                if destination == .signIn { store.wantsSignIn = true }
                introDone = true
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
