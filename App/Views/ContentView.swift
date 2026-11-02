import SwiftUI

/// Root routing (see AuthGate): brand-new people get the intro
/// carousel, then the onboarding conversation with sign-in as
/// its final step. Anyone who has signed in on this phone
/// before lands on the log in page when signed out. After
/// onboarding, the one Home feed. There is deliberately no tab
/// bar anywhere in Hygge.
struct ContentView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--settings-preview") {
            SettingsPreviewHost()
        } else { appContent }
        #else
        appContent
        #endif
    }

    @ViewBuilder private var appContent: some View {
        routedContent
            .sheet(isPresented: Binding(get: { store.passwordFlow != nil && !store.isShowingLogins && !store.isShowingProfile },
                                        set: { if !$0 { store.passwordFlow = nil } })) {
                PasswordConfirmationView().presentationDragIndicator(.visible)
            }
    }

    @ViewBuilder private var routedContent: some View {
        switch AuthGate.resolve(introDone: store.introDone,
                                hasOnboarded: store.hasOnboarded,
                                isSignedIn: store.isSignedIn,
                                authRequired: BackendClient.requireCloud,
                                wantsSignIn: store.wantsSignIn,
                                hasSignedInBefore: store.hasSignedInBefore,
                                wantsOnboarding: store.wantsOnboarding,
                                isExistingAccount: store.isExistingAccount) {
        case .carousel:
            IntroCarouselView { destination in
                // The latest tap is the intent: clear the opposite
                // flag so a stale Sign up can never swallow Log in.
                if destination == .signIn {
                    store.wantsOnboarding = false
                    store.wantsSignIn = true
                }
                store.introDone = true
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
