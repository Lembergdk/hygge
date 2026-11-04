import SwiftUI

/// Password set/change confirmation, rendered with the same
/// "Check your email" page as every other emailed link. The
/// cancel here is real: the server drops the pending password
/// (see PasswordConfirmation.swift).
struct PasswordConfirmationView: View {
    @Environment(AppStore.self) private var store
    @State private var message: String?
    @State private var cancelling = false

    var body: some View {
        if let flow = store.passwordFlow {
            MagicLinkPageView(
                purpose: .password,
                email: flow.email,
                phase: pagePhase(flow),
                note: message,
                onUseDifferentEmail: nil,
                onProblemPrimary: { store.passwordFlow = nil },
                onDone: { store.passwordFlow = nil },
                cancelTitle: flow.phase == .waiting ? "Cancel password change" : nil,
                onCancel: { Task { await cancel(flow) } },
                cancelDisabled: cancelling)
        }
    }

    private func pagePhase(_ flow: PasswordConfirmationState) -> MagicLinkPageView.Phase {
        switch flow.phase {
        case .waiting: return .waiting
        case .confirming: return .working
        case .saved: return .done(detail: "You can now use your new password to log in.")
        case .failed:
            return .problem(message: flow.message ?? "The confirmation couldn't be completed. Please try again.",
                            primaryTitle: "Back to Hygge")
        }
    }

    private func cancel(_ flow: PasswordConfirmationState) async {
        guard let id = flow.requestID else { store.passwordFlow = nil; return }
        cancelling = true
        defer { cancelling = false }
        do {
            try await store.backend.cancelPasswordConfirmation(id: id)
            store.passwordFlow = nil
        } catch { message = "We couldn’t cancel just now. Try again. Your password stays unchanged unless you confirm the email link." }
    }
}
