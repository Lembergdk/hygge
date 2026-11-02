import SwiftUI
import AuthenticationServices

/// The sign-in card inside the onboarding conversation: Apple's
/// official button first, then an email field that sends a sign-in
/// link or signs in with an existing password. The same
/// card serves the returning-user "sign in" path on its own.
struct SignInCard: View {
    /// The locally collected onboarding answers, when sign-in is the
    /// final onboarding step. Nil for a plain returning sign-in.
    var localProfile: EarningsProfile?
    var isReturningLogin = false
    var onSignedIn: () -> Void

    @Environment(AppStore.self) private var store
    @State private var email = ""
    @State private var message: String?
    @State private var isWorking = false
    @State private var currentNonce: String?
    @State private var password = ""
    @State private var usesPassword = false
    @FocusState private var emailFocused: Bool

    private var showsEmailActions: Bool {
        HyggeAuth.showsEmailActions(email: email, isFocused: emailFocused)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SignInWithAppleButton(.signIn) { request in
                let nonce = Self.makeNonce()
                currentNonce = nonce
                request.requestedScopes = [.fullName, .email]
                request.nonce = nonce
            } onCompletion: { result in
                handleApple(result)
            }
            .signInWithAppleButtonStyle(.black)
            .frame(height: 52)
            .clipShape(Capsule())
            .accessibilityLabel("Sign in with Apple")

            HStack(spacing: 12) {
                Rectangle().fill(HyggeTheme.hairline).frame(height: 1)
                Text("or").font(.caption).foregroundStyle(HyggeTheme.secondary)
                Rectangle().fill(HyggeTheme.hairline).frame(height: 1)
            }
            .accessibilityHidden(true)

            if isReturningLogin {
                HStack(spacing: 12) {
                    Image(systemName: "envelope").foregroundStyle(HyggeTheme.secondary)
                    TextField("Email address", text: $email)
                        .textContentType(.emailAddress).keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .focused($emailFocused).submitLabel(.next)
                        .accessibilityIdentifier("login.email")
                }.settingsField()

                if showsEmailActions {
                    if usesPassword {
                        AccountPasswordField(title: "Password", password: $password, isNew: false)
                    }
                    Button {
                        emailFocused = false
                        Task { if usesPassword { await signInWithPassword() } else { await sendLink() } }
                    } label: {
                        if isWorking { ProgressView().tint(HyggeTheme.onSage) }
                        else { Text(usesPassword ? "Log in" : "Email me a link") }
                    }
                    .buttonStyle(SettingsActionStyle())
                    .disabled(!HyggeAuth.isPlausibleEmail(email) || isWorking || (usesPassword && password.isEmpty))
                    .opacity(HyggeAuth.isPlausibleEmail(email) && (!usesPassword || !password.isEmpty) ? 1 : 0.45)
                    .accessibilityIdentifier("login.submit")

                    Button(usesPassword ? "Use an email link" : "Use a password") {
                        usesPassword.toggle()
                        password = ""
                        message = nil
                        store.magicLinkError = nil
                    }
                    .font(.subheadline.weight(.medium)).foregroundStyle(HyggeTheme.sageDeep)
                    .frame(maxWidth: .infinity, minHeight: 44).buttonStyle(.plain)
                    .disabled(isWorking || !HyggeAuth.isPlausibleEmail(email))
                    .opacity(HyggeAuth.isPlausibleEmail(email) ? 1 : 0.45)
                    .accessibilityIdentifier("login.switchMethod")
                }
            } else {
                HStack(spacing: 10) {
                    TextField("Email", text: $email)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(.horizontal, 17).padding(.vertical, 13)
                        .background(HyggeTheme.card, in: Capsule())
                        .overlay(Capsule().stroke(HyggeTheme.hairline, lineWidth: 1))
                        .accessibilityLabel("Email address")
                    Button {
                        Task { await sendLink() }
                    } label: {
                        Group {
                            if isWorking { ProgressView().tint(.white) }
                            else {
                                Image(systemName: "paperplane.fill")
                                    .font(.system(size: 17, weight: .semibold))
                            }
                        }
                        .frame(width: 50, height: 50)
                        .background(HyggeTheme.emberDeep, in: Circle())
                        .foregroundStyle(.white)
                    }
                    .buttonStyle(.plain)
                    .disabled(!HyggeAuth.isPlausibleEmail(email) || isWorking)
                    .opacity(HyggeAuth.isPlausibleEmail(email) && !isWorking ? 1 : 0.45)
                    .accessibilityLabel("Email me a sign-in link")
                }
            }

            if let error = store.magicLinkError {
                Text(error)
                    .font(.subheadline)
                    .foregroundStyle(HyggeTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let message {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(HyggeTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .disabled(isWorking)
        .onDisappear { password = "" }
        .onChange(of: store.pendingMagicToken) { _, token in
            guard let token else { return }
            store.pendingMagicToken = nil
            Task { await consume(token) }
        }
        .task {
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--settings-preview") {
                email = UserDefaults.standard.string(forKey: "loginPreviewEmail") ?? ""
                usesPassword = UserDefaults.standard.bool(forKey: "loginPreviewPassword")
            }
            #endif
            // A link tapped before this card appeared (cold launch).
            if let token = store.pendingMagicToken {
                store.pendingMagicToken = nil
                await consume(token)
            }
        }
    }

    private func signInWithPassword() async {
        isWorking = true
        message = nil
        store.magicLinkError = nil
        defer { isWorking = false }
        do {
            try await store.backend.signInWithPassword(email: email, password: password)
            password = ""
            await store.finishSignIn(localProfile: localProfile)
            onSignedIn()
        } catch { message = AuthCopy.message(for: error) }
    }

    private func sendLink() async {
        isWorking = true
        message = nil
        store.magicLinkError = nil
        defer { isWorking = false }
        do {
            message = try await store.backend.requestMagicLink(email: email)
        } catch {
            message = AuthCopy.message(for: error)
        }
    }

    private func consume(_ token: String) async {
        isWorking = true
        defer { isWorking = false }
        do {
            let linked = try await store.backend.consumeMagicLink(token: token)
            if linked != nil {
                // Signed-in link mode: the email now opens this account.
                message = "Email sign-in added. Either way in opens this same account."
                store.magicLinkError = nil
            } else {
                await store.finishSignIn(localProfile: localProfile)
                onSignedIn()
            }
        } catch {
            store.magicLinkError = AuthCopy.message(for: error)
            message = nil
        }
    }

    private func handleApple(_ result: Result<ASAuthorization, Error>) {
        switch result {
        case .failure(let error):
            // Backing out of the Apple sheet is not an error to report.
            if (error as? ASAuthorizationError)?.code != .canceled {
                message = "Apple sign-in didn't work just now. Try again, or use email below."
            }
        case .success(let authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let tokenData = credential.identityToken,
                  let identityToken = String(data: tokenData, encoding: .utf8) else {
                message = "Apple sign-in didn't work just now. Try again, or use email below."
                return
            }
            let displayName = credential.fullName.map {
                PersonNameComponentsFormatter().string(from: $0)
            }.flatMap { $0.isEmpty ? nil : $0 }
            let nonce = currentNonce
            isWorking = true
            message = nil
            Task {
                defer { isWorking = false }
                do {
                    try await store.backend.signInWithApple(
                        identityToken: identityToken, nonce: nonce, displayName: displayName)
                    await store.finishSignIn(localProfile: localProfile)
                    onSignedIn()
                } catch {
                    message = AuthCopy.message(for: error)
                }
            }
        }
    }

    static func makeNonce() -> String {
        (UUID().uuidString + UUID().uuidString).replacingOccurrences(of: "-", with: "").lowercased()
    }
}

enum AuthCopy {
    static func message(for error: Error) -> String {
        (error as? AuthClientError)?.errorDescription
            ?? "Sign-in is unavailable just now. Try again in a moment."
    }
}
