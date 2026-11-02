import SwiftUI
import UIKit

struct PasswordConfirmationView: View {
    @Environment(AppStore.self) private var store
    @State private var message: String?
    @State private var cancelling = false
    @AppStorage("preferredMailAppScheme") private var preferredMailApp = "message://"

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                Spacer(minLength: 24)
                Image(systemName: saved ? "checkmark.circle.fill" : "envelope.badge")
                    .font(.system(size: 56, weight: .light)).foregroundStyle(HyggeTheme.sageDeep)
                    .accessibilityHidden(true)
                Text(title).font(.system(.title, design: .rounded, weight: .bold))
                    .foregroundStyle(HyggeTheme.ink)
                if let flow = store.passwordFlow {
                    switch flow.phase {
                    case .waiting:
                        Text("We sent a confirmation email to")
                        Text(flow.email).fontWeight(.semibold).foregroundStyle(HyggeTheme.ink)
                        Text("Tap the link in that email to save your new password. The link works for 15 minutes.")
                        Button("Open mail") { openMail(preferredMailApp) }.buttonStyle(SettingsActionStyle())
                        Menu("Use another mail app") {
                            Button("Apple Mail") { openMail("message://") }
                            Button("Gmail") { openMail("googlegmail://") }
                            Button("Outlook") { openMail("ms-outlook://") }
                            Button("Spark") { openMail("readdle-spark://") }
                        }.foregroundStyle(HyggeTheme.sageDeep).frame(minHeight: 44)
                        Button("Cancel password change") { Task { await cancel(flow) } }
                            .foregroundStyle(HyggeTheme.secondary).frame(minHeight: 44).disabled(cancelling)
                    case .confirming:
                        ProgressView().tint(HyggeTheme.sageDeep)
                        Text("Saving your password…")
                    case .saved:
                        Text("You can now use your new password to log in.")
                        Button("Done") { store.passwordFlow = nil }.buttonStyle(SettingsActionStyle())
                    case .failed:
                        Text(flow.message ?? "The confirmation couldn’t be completed. Please try again.")
                        Button("Back to Hygge") { store.passwordFlow = nil }.buttonStyle(SettingsActionStyle())
                    }
                }
                if let message { Text(message).font(.subheadline).accessibilityAddTraits(.updatesFrequently) }
                Spacer(minLength: 24)
            }.padding(28).frame(maxWidth: 520)
                .frame(maxWidth: .infinity).multilineTextAlignment(.center)
                .foregroundStyle(HyggeTheme.secondary)
        }
        .background(HyggeTheme.paper).fontDesign(.rounded)
        .interactiveDismissDisabled(store.passwordFlow?.phase == .confirming)
    }

    private var saved: Bool { store.passwordFlow?.phase == .saved }
    private var title: String {
        switch store.passwordFlow?.phase {
        case .waiting: return "Check your email"
        case .confirming: return "One moment"
        case .saved: return "Password saved"
        case .failed: return "Let’s try that again"
        case nil: return "Your password"
        }
    }

    private func openMail(_ scheme: String) {
        guard let url = URL(string: scheme) else { return }
        UIApplication.shared.open(url, options: [:]) { opened in
            if opened { preferredMailApp = scheme; message = nil }
            else { message = "That mail app couldn’t open. Choose another above, or open your email app and find the message from Hygge." }
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
