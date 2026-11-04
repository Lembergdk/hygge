import SwiftUI
import UIKit

/// The one "Check your email" page for every emailed link: sign
/// up, log in, adding email sign-in, and password confirmation.
/// One centered column so it holds at accessibility text sizes;
/// one primary action; quiet text exits. Words come from
/// HyggeCore's MagicLinkPageCopy so no surface can drift.
struct MagicLinkPageView: View {
    enum Phase: Equatable {
        case waiting
        case working
        case problem(message: String, primaryTitle: String)
        case done(detail: String)
    }

    var purpose: MagicLinkPurpose
    var email: String
    var phase: Phase
    var sentAt: Date = Date()
    var note: String?
    var onResend: (() -> Void)?
    var onUseDifferentEmail: (() -> Void)?
    var onProblemPrimary: (() -> Void)?
    var onDone: (() -> Void)?
    /// Password only: a real server-backed cancel replaces the
    /// resend/different-email row (a new link needs the password
    /// typed again, so there is nothing to resend).
    var cancelTitle: String?
    var onCancel: (() -> Void)?
    var cancelDisabled = false

    @State private var mailMessage: String?
    @AppStorage("preferredMailAppScheme") private var preferredMailApp = "message://"

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Spacer(minLength: 24)
                Image(systemName: iconName)
                    .font(.system(size: 56, weight: .light))
                    .foregroundStyle(HyggeTheme.sageDeep)
                    .accessibilityHidden(true)
                Text(title)
                    .font(.system(.title, design: .rounded, weight: .bold))
                    .foregroundStyle(HyggeTheme.ink)
                    .padding(.top, 22)
                content
                if let note {
                    Text(note).font(.subheadline).padding(.top, 18)
                        .accessibilityAddTraits(.updatesFrequently)
                }
                if let mailMessage {
                    Text(mailMessage).font(.subheadline).padding(.top, 18)
                        .accessibilityAddTraits(.updatesFrequently)
                }
                Spacer(minLength: 24)
            }
            .padding(28)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
            .multilineTextAlignment(.center)
            .foregroundStyle(HyggeTheme.secondary)
        }
        .background(HyggeTheme.paper)
        .fontDesign(.rounded)
        .interactiveDismissDisabled(phase == .working)
    }

    @ViewBuilder private var content: some View {
        switch phase {
        case .waiting:
            VStack(spacing: 0) {
                Text(MagicLinkPageCopy.sentSentence(purpose)).padding(.top, 16)
                if !email.isEmpty {
                    Text(email).fontWeight(.semibold).foregroundStyle(HyggeTheme.ink)
                        .padding(.top, 4)
                        .textSelection(.enabled)
                }
                Text(MagicLinkPageCopy.tapSentence(purpose))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 14)
                Button("Open mail") { openMail(preferredMailApp) }
                    .buttonStyle(MagicLinkPrimaryStyle())
                    .padding(.top, 30)
                Menu("Use another mail app") {
                    Button("Apple Mail") { openMail("message://") }
                    Button("Gmail") { openMail("googlegmail://") }
                    Button("Outlook") { openMail("ms-outlook://") }
                    Button("Spark") { openMail("readdle-spark://") }
                }
                .font(.body.weight(.medium))
                .foregroundStyle(HyggeTheme.sageDeep)
                .frame(minHeight: 44)
                .padding(.top, 6)
                quietRow
            }
        case .working:
            VStack(spacing: 0) {
                ProgressView().tint(HyggeTheme.sageDeep).padding(.top, 26)
                Text(MagicLinkPageCopy.workingText(purpose)).padding(.top, 16)
            }
        case .problem(let message, let primaryTitle):
            VStack(spacing: 0) {
                Text(message)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 16)
                if !email.isEmpty && onResend != nil {
                    Text(email).fontWeight(.semibold).foregroundStyle(HyggeTheme.ink)
                        .padding(.top, 10)
                }
                Button(primaryTitle) { onProblemPrimary?() }
                    .buttonStyle(MagicLinkPrimaryStyle())
                    .padding(.top, 30)
                if let onUseDifferentEmail {
                    Button("Use a different email", action: onUseDifferentEmail)
                        .font(.body.weight(.medium))
                        .foregroundStyle(HyggeTheme.secondary)
                        .frame(minHeight: 44)
                        .buttonStyle(.plain)
                        .padding(.top, 6)
                }
            }
        case .done(let detail):
            VStack(spacing: 0) {
                Text(detail)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 16)
                Button("Done") { onDone?() }
                    .buttonStyle(MagicLinkPrimaryStyle())
                    .padding(.top, 30)
            }
        }
    }

    @ViewBuilder private var quietRow: some View {
        if let cancelTitle, let onCancel {
            Button(cancelTitle, action: onCancel)
                .font(.body.weight(.medium))
                .foregroundStyle(HyggeTheme.secondary)
                .frame(minHeight: 44)
                .buttonStyle(.plain)
                .disabled(cancelDisabled)
        } else if onResend != nil || onUseDifferentEmail != nil {
            TimelineView(.periodic(from: sentAt, by: 1)) { context in
                let remaining = MagicLinkPageCopy.resendSecondsRemaining(sentAt: sentAt, now: context.date)
                HStack(spacing: 10) {
                    if let onResend {
                        Button(MagicLinkPageCopy.resendLabel(secondsRemaining: remaining), action: onResend)
                            .disabled(remaining > 0)
                            .opacity(remaining > 0 ? 0.55 : 1)
                            .accessibilityLabel(remaining > 0
                                ? "Resend email, available in \(remaining) seconds"
                                : "Resend email")
                    }
                    if onResend != nil && onUseDifferentEmail != nil {
                        Text("·").accessibilityHidden(true)
                    }
                    if let onUseDifferentEmail {
                        Button("Use a different email", action: onUseDifferentEmail)
                    }
                }
                .font(.body.weight(.medium))
                .foregroundStyle(HyggeTheme.secondary)
                .frame(minHeight: 44)
            }
        }
    }

    private var iconName: String {
        if case .done = phase { return "checkmark.circle.fill" }
        return "envelope.badge"
    }

    private var title: String {
        switch phase {
        case .waiting: return "Check your email"
        case .working: return "One moment"
        case .problem: return "That link didn't work"
        case .done: return MagicLinkPageCopy.doneTitle(purpose) ?? "Done"
        }
    }

    private func openMail(_ scheme: String) {
        guard let url = URL(string: scheme) else { return }
        UIApplication.shared.open(url, options: [:]) { opened in
            if opened { preferredMailApp = scheme; mailMessage = nil }
            else { mailMessage = "That mail app couldn’t open. Choose another above, or open your email app and find the message from Hygge." }
        }
    }
}

/// The one primary action on the page.
private struct MagicLinkPrimaryStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .dynamicTypeSize(.large...)
            .frame(maxWidth: .infinity, minHeight: 52)
            .padding(.horizontal, 16)
            .foregroundStyle(.white)
            .background(HyggeTheme.emberDeep, in: Capsule())
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

/// Store-driven adapter for the sign-in-link flow.
struct MagicLinkWaitView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        if let flow = store.magicLinkFlow {
            MagicLinkPageView(
                purpose: flow.purpose,
                email: flow.email,
                phase: pagePhase(flow),
                sentAt: flow.sentAt,
                note: flow.note,
                onResend: flow.email.isEmpty ? nil : { Task { await store.resendMagicLink() } },
                onUseDifferentEmail: { store.magicLinkFlow = nil },
                onProblemPrimary: { Task { await store.magicLinkProblemPrimary() } },
                onDone: { store.magicLinkFlow = nil })
        }
    }

    private func pagePhase(_ flow: MagicLinkFlowState) -> MagicLinkPageView.Phase {
        switch flow.phase {
        case .waiting: return .waiting
        case .working: return .working
        case .problem(let message, let action):
            return .problem(message: message,
                            primaryTitle: action == .loadAccount ? "Load my account" : "Send a new link")
        case .done:
            return .done(detail: "You can now sign in with \(flow.email.isEmpty ? "this email" : flow.email).")
        }
    }
}
