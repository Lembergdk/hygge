import Foundation

/// No password or link token lives here. The server holds a short-lived salted
/// hash until the purpose-scoped email link confirms it, including after restart.
struct PasswordConfirmationState: Identifiable {
    enum Phase { case waiting, confirming, saved, failed }
    var id = UUID()
    var phase: Phase
    var email = ""
    var requestID: String?
    var message: String?
}

extension AppStore {
    func finishPasswordConfirmation(token: String) async {
        guard passwordFlow?.phase != .confirming else { return }
        passwordFlow = PasswordConfirmationState(phase: .confirming)
        do {
            let wasSignedIn = isSignedIn
            try await backend.confirmPassword(token: token)
            if !wasSignedIn { await finishSignIn() }
            else { refreshAuthState() }
            passwordFlow = PasswordConfirmationState(phase: .saved)
        } catch {
            passwordFlow = PasswordConfirmationState(phase: .failed, message: AuthCopy.message(for: error))
        }
    }
}
