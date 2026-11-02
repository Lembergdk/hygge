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
            VStack(spacing: 0) {
                HStack {
                    Button("Sign up") {
                        store.wantsSignIn = false
                        store.wantsOnboarding = true
                    }
                    .font(.body)
                    .foregroundStyle(HyggeTheme.secondary)
                    .buttonStyle(.plain)
                    Spacer()
                }
                .padding(.top, 14)
                .padding(.leading, 22)
                FlameMark(size: 72)
                    .padding(.top, 40)
                    .padding(.bottom, 36)
                SignInCard(localProfile: nil) {}
                    .padding(.horizontal, 22)
                Spacer()
            }
        }
        .fontDesign(.rounded)
    }
}
