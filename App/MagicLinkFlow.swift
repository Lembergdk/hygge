import Foundation

/// The one emailed-link flow, owned by the store so it survives
/// app switches and cold launches: sending a link opens the
/// "Check your email" page, and the tapped link is consumed here
/// in place — never by re-routing to a different screen (that
/// swap once destroyed an in-progress onboarding). No link token
/// is ever stored in this state.
struct MagicLinkFlowState: Identifiable {
    enum ProblemAction: Equatable {
        case sendNewLink
        case loadAccount
    }
    enum Phase: Equatable {
        case waiting
        case working
        case problem(String, ProblemAction)
        case done
    }
    var id = UUID()
    var purpose: MagicLinkPurpose
    /// The address the person typed (shown back to them so a typo
    /// is visible). Empty only when the app was cold-launched by
    /// the link tap itself and never saw the form.
    var email: String
    var phase: Phase = .waiting
    var sentAt = Date()
    /// Small transient line under the actions (e.g. a resend that
    /// didn't go through).
    var note: String?
}

extension AppStore {
    /// Send a sign-in link and open the waiting page. The server's
    /// answer stays enumeration-safe; the page's words are local.
    func beginMagicLink(purpose: MagicLinkPurpose, email: String,
                        localProfile: EarningsProfile? = nil) async {
        let address = HyggeAuth.normalizeEmail(email)
        if purpose == .signUp, let localProfile {
            // Hand the answers to the store NOW: whenever and
            // wherever the link is consumed, finishing sign-in can
            // still complete onboarding with them exactly once.
            pendingOnboardingProfile = localProfile
        }
        magicLinkError = nil
        do {
            _ = try await backend.requestMagicLink(email: address)
            magicLinkFlow = MagicLinkFlowState(purpose: purpose, email: address)
        } catch {
            magicLinkFlow = MagicLinkFlowState(
                purpose: purpose, email: address,
                phase: .problem(AuthCopy.message(for: error), .sendNewLink))
        }
    }

    func resendMagicLink() async {
        guard let flow = magicLinkFlow, !flow.email.isEmpty else { return }
        do {
            _ = try await backend.requestMagicLink(email: flow.email)
            magicLinkFlow?.phase = .waiting
            magicLinkFlow?.sentAt = Date()
            magicLinkFlow?.note = nil
        } catch {
            magicLinkFlow?.note = AuthCopy.message(for: error)
        }
    }

    /// Consume a tapped link under the purpose that sent it.
    func consumeMagicToken(_ token: String) async {
        guard !magicConsumeInFlight else { return }
        magicConsumeInFlight = true
        defer { magicConsumeInFlight = false }
        let purpose = MagicLinkPageCopy.arrivalPurpose(
            isSignedIn: isSignedIn, activePurpose: magicLinkFlow?.purpose)
        if magicLinkFlow == nil {
            magicLinkFlow = MagicLinkFlowState(purpose: purpose, email: "", phase: .working)
        } else {
            magicLinkFlow?.phase = .working
        }
        magicLinkError = nil
        do {
            if try await backend.consumeMagicLink(token: token) != nil {
                // The link added email sign-in to the signed-in
                // account; settings reloads its list off .done.
                magicLinkFlow?.purpose = .addEmail
                magicLinkFlow?.phase = .done
                return
            }
            await finishSignIn(localProfile: pendingOnboardingProfile)
            settleMagicLinkAfterFinish(purpose: purpose)
        } catch {
            magicLinkFlow?.phase = .problem(AuthCopy.message(for: error), .sendNewLink)
        }
    }

    /// The problem page's one button, per problem kind.
    func magicLinkProblemPrimary() async {
        guard case .problem(_, let action) = magicLinkFlow?.phase else { return }
        switch action {
        case .sendNewLink:
            // Cold-launched by the tap: no address on file to
            // resend to, so the button simply closes the page and
            // the sign-in form underneath takes it from there.
            if magicLinkFlow?.email.isEmpty == true { magicLinkFlow = nil; return }
            await resendMagicLink()
        case .loadAccount:
            magicLinkFlow?.phase = .working
            await finishSignIn(localProfile: pendingOnboardingProfile)
            settleMagicLinkAfterFinish(purpose: magicLinkFlow?.purpose ?? .signIn)
        }
    }

    private func settleMagicLinkAfterFinish(purpose: MagicLinkPurpose) {
        if let error = magicLinkError {
            // Signed in, but the account wouldn't load: same page,
            // retry button — never a silent dead end.
            magicLinkFlow?.phase = .problem(error, backend.hasSessionToken ? .loadAccount : .sendNewLink)
            return
        }
        magicLinkFlow = nil
        if purpose == .signUp {
            Task { await refreshProposalsFromBackend() }
        }
    }
}
