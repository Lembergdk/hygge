import SwiftUI

/// Root: first launch shows the intro carousel once, then the
/// conversational onboarding; after that, the one Home feed.
/// There is deliberately no tab bar anywhere in Hygge.
struct ContentView: View {
    @Environment(AppStore.self) private var store
    @AppStorage("hasSeenIntroCarousel") private var hasSeenCarousel = false

    var body: some View {
        if !store.hasOnboarded {
            if hasSeenCarousel {
                OnboardingView()
            } else {
                // Carousel → signup entry point (spec §9). Until the
                // signup screen exists (auth method still open), both
                // destinations continue into the conversational
                // onboarding; this branch is the single swap point.
                IntroCarouselView { _ in
                    hasSeenCarousel = true
                }
            }
        } else {
            NavigationStack {
                HomeFeedView()
            }
        }
    }
}
