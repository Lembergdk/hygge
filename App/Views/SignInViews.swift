import SwiftUI
import AuthenticationServices

/// The sign-in card inside the onboarding conversation: Apple's
/// official button first, then an email field that sends a sign-in
/// link. There is no password and no separate sign-in page. The same
/// card serves the returning-user "sign in" path on its own.
struct SignInCard: View {
    /// The locally collected onboarding answers, when sign-in is the
    /// final onboarding step. Nil for a plain returning sign-in.
    var localProfile: EarningsProfile?
    var onSignedIn: () -> Void

    @Environment(AppStore.self) private var store
    @State private var email = ""
    @State private var message: String?
    @State private var isWorking = false
    @State private var currentNonce: String?

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

            // Field and send sit on one line: the round send
            // button needs no label next to an email field.
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
        .onChange(of: store.pendingMagicToken) { _, token in
            guard let token else { return }
            store.pendingMagicToken = nil
            Task { await consume(token) }
        }
        .task {
            // A link tapped before this card appeared (cold launch).
            if let token = store.pendingMagicToken {
                store.pendingMagicToken = nil
                await consume(token)
            }
        }
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

/// Ways into the account, for Profile: list, add (Apple directly, or
/// email via a sign-in link), and remove — always while signed in,
/// never the last one.
struct LoginMethodsContent: View {
    @Environment(AppStore.self) private var store
    @State private var methods: [LinkedLoginMethod] = []
    @State private var linkEmail = ""
    @State private var message: String?
    @State private var isWorking = false
    @State private var currentNonce: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            Text("Connected").font(.title3.weight(.bold)).foregroundStyle(HyggeTheme.ink)
            if methods.isEmpty {
                Text("No login methods loaded yet.").font(.subheadline).foregroundStyle(HyggeTheme.secondary)
            }
            ForEach(methods) { method in
                HStack(spacing: 14) {
                    Image(systemName: method.method == .apple ? "applelogo" : "envelope")
                        .font(.title2).foregroundStyle(HyggeTheme.ink).frame(width: 40)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(method.method.label).font(.headline).foregroundStyle(HyggeTheme.ink)
                        if let email = method.email { Text(email).font(.caption).foregroundStyle(HyggeTheme.secondary) }
                    }
                    Spacer(minLength: 0)
                    if HyggeAuth.canRemoveLoginMethod(methodCount: methods.count) {
                        Menu {
                            Button("Remove login", role: .destructive) { Task { await remove(method) } }
                        } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44) }
                        .disabled(isWorking).accessibilityLabel("Manage \(method.method.label) login")
                    } else {
                        Image(systemName: "checkmark.circle.fill").foregroundStyle(HyggeTheme.sageDeep)
                            .accessibilityLabel("Connected")
                    }
                }.settingsSurface()
            }
            Text("Add another way").font(.title3.weight(.bold)).foregroundStyle(HyggeTheme.ink).padding(.top, 12)
            if !methods.contains(where: { $0.method == .apple }) {
                SignInWithAppleButton(.signIn) { request in
                    let nonce = SignInCard.makeNonce()
                    currentNonce = nonce
                    request.requestedScopes = [.email]
                    request.nonce = nonce
                } onCompletion: { result in handleAppleLink(result) }
                .signInWithAppleButtonStyle(.black).frame(height: 48).clipShape(Capsule())
                .accessibilityLabel("Add Sign in with Apple").disabled(isWorking)
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("Email address").font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                TextField("you@example.com", text: $linkEmail)
                    .textContentType(.emailAddress).keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .settingsField().accessibilityLabel("Email to add")
            }
            Button { Task { await sendLink() } } label: {
                if isWorking { ProgressView() } else { Text("Send sign-in link") }
            }.buttonStyle(SettingsActionStyle())
                .disabled(!HyggeAuth.isPlausibleEmail(linkEmail) || isWorking)
                .opacity(HyggeAuth.isPlausibleEmail(linkEmail) && !isWorking ? 1 : 0.5)
            if let magicError = store.magicLinkError { Text(magicError).font(.caption).foregroundStyle(HyggeTheme.secondary) }
            if let message { Text(message).font(.caption).foregroundStyle(HyggeTheme.secondary) }
        }
        .task {
            await load()
            // A link tapped before this section appeared (cold
            // launch straight to Home): consume it now instead of
            // stranding it until some later, unrelated change.
            if let token = store.pendingMagicToken {
                store.pendingMagicToken = nil
                await consumeLink(token)
            }
        }
        .onChange(of: store.pendingMagicToken) { _, token in
            guard let token else { return }
            store.pendingMagicToken = nil
            Task { await consumeLink(token) }
        }
    }

    private func load() async {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--settings-preview") {
            methods = [LinkedLoginMethod(id: "preview", method: .apple, email: "m@example.com")]
            return
        }
        #endif
        do { methods = try await store.backend.fetchLoginMethods() }
        catch { message = "Your logins couldn’t be loaded. Try again when you’re connected." }
    }

    private func sendLink() async {
        isWorking = true
        store.magicLinkError = nil
        defer { isWorking = false }
        do {
            message = try await store.backend.requestMagicLink(email: linkEmail)
        } catch {
            message = AuthCopy.message(for: error)
        }
    }

    private func consumeLink(_ token: String) async {
        isWorking = true
        defer { isWorking = false }
        do {
            if let updated = try await store.backend.consumeMagicLink(token: token) {
                methods = updated
                linkEmail = ""
                message = "Email sign-in added. Either way in opens this same account."
                store.magicLinkError = nil
            }
        } catch {
            store.magicLinkError = AuthCopy.message(for: error)
        }
    }

    private func remove(_ method: LinkedLoginMethod) async {
        isWorking = true
        defer { isWorking = false }
        do {
            methods = try await store.backend.unlinkLoginMethod(id: method.id)
            message = "Removed. Your other way in still works."
        } catch {
            message = AuthCopy.message(for: error)
        }
    }

    private func handleAppleLink(_ result: Result<ASAuthorization, Error>) {
        guard case .success(let authorization) = result,
              let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = credential.identityToken,
              let identityToken = String(data: tokenData, encoding: .utf8) else {
            if case .failure(let error) = result, (error as? ASAuthorizationError)?.code != .canceled {
                message = "Adding Apple sign-in didn't work just now. Try again."
            }
            return
        }
        let nonce = currentNonce
        isWorking = true
        Task {
            defer { isWorking = false }
            do {
                methods = try await store.backend.linkApple(identityToken: identityToken, nonce: nonce)
                message = "Apple sign-in added. Either way in opens this same account."
            } catch {
                message = AuthCopy.message(for: error)
            }
        }
    }
}
