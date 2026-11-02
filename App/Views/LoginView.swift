import SwiftUI

/// The log in page: as little text as possible. Reached from the
/// intro carousel's "Log in" and whenever a signed-out returning
/// user needs back in. The controls are the same SignInCard used
/// as onboarding's final message; a successful sign-in routes
/// itself (Home for an onboarded account, otherwise the
/// onboarding questions continue).
struct LoginView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        ZStack {
            HyggeTheme.paper.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 0) {
                    HStack {
                        Button("Sign up") {
                            store.wantsSignIn = false
                            store.wantsOnboarding = true
                            // Back to the very first onboarding page,
                            // even if the carousel ran earlier today.
                            store.introDone = false
                        }
                        .font(.body)
                        .foregroundStyle(HyggeTheme.secondary)
                        .buttonStyle(.plain)
                        Spacer()
                    }
                    .padding(.top, 14)
                    .padding(.leading, 22)
                    AnimatedFlame(size: 132)
                        .padding(.top, 28)
                        .padding(.bottom, 12)
                    Text("Welcome back")
                        .font(.system(.largeTitle, design: .rounded, weight: .bold))
                        .foregroundStyle(HyggeTheme.ink)
                        .padding(.bottom, 32)
                    SignInCard(localProfile: nil, isReturningLogin: true) {}
                        .padding(.horizontal, 22)
                    Spacer(minLength: 30)
                }
            }.scrollDismissesKeyboard(.interactively)
        }
        .fontDesign(.rounded)
    }
}
