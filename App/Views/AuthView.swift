import SwiftUI
import AuthenticationServices

/// Sign up / sign in (Brief 00): Apple's official button first, then
/// email and password. Either method opens the same account once
/// linked, and the other can be added later in Profile.
struct AuthView: View {
    var destination: AuthDestination = .signup
    var onAuthenticated: () -> Void

    @Environment(AppStore.self) private var store
    @State private var isSigningUp = true
    @State private var email = ""
    @State private var password = ""
    @State private var errorMessage: String?
    @State private var isWorking = false
    @State private var currentNonce: String?

    var body: some View {
        ZStack {
            HyggeTheme.paper.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 18) {
                    FlameMark(size: 54).padding(.top, 36)
                    Text(isSigningUp ? "Create your account" : "Welcome back")
                        .font(.system(size: 28, weight: .bold, design: .rounded))
                        .foregroundStyle(HyggeTheme.ink)
                    Text("One account for your feed, your sites, and everything Hygge does for you.")
                        .font(.body)
                        .foregroundStyle(HyggeTheme.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)

                    SignInWithAppleButton(isSigningUp ? .signUp : .signIn) { request in
                        let nonce = Self.makeNonce()
                        currentNonce = nonce
                        request.requestedScopes = [.fullName, .email]
                        request.nonce = nonce
                    } onCompletion: { result in
                        handleApple(result) { try await store.backend.signInWithApple(
                            identityToken: $0, nonce: $1, displayName: $2) }
                    }
                    .signInWithAppleButtonStyle(.black)
                    .frame(height: 52)
                    .clipShape(Capsule())
                    .accessibilityLabel(isSigningUp ? "Sign up with Apple" : "Sign in with Apple")

                    divider
                    emailForm

                    if let errorMessage {
                        Text(errorMessage)
                            .font(.subheadline)
                            .foregroundStyle(HyggeTheme.emberDeep)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityLabel("Error: \(errorMessage)")
                    }

                    Button(isSigningUp
                           ? "Already have an account? Sign in"
                           : "New here? Create your account") {
                        isSigningUp.toggle()
                        errorMessage = nil
                        password = ""
                    }
                    .font(.subheadline)
                    .foregroundStyle(HyggeTheme.secondary)
                    .buttonStyle(.plain)

                    if isSigningUp {
                        Text("Keep your password somewhere safe. Email password resets aren't available yet, so adding Apple sign-in later gives you another way back in.")
                            .font(.caption)
                            .foregroundStyle(HyggeTheme.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 28)
            }
        }
        .fontDesign(.rounded)
        .onAppear { isSigningUp = destination == .signup }
    }

    private var divider: some View {
        HStack(spacing: 12) {
            Rectangle().fill(HyggeTheme.hairline).frame(height: 1)
            Text("or with email").font(.caption).foregroundStyle(HyggeTheme.secondary)
            Rectangle().fill(HyggeTheme.hairline).frame(height: 1)
        }
        .accessibilityHidden(true)
    }

    private var formIsValid: Bool {
        HyggeAuth.isPlausibleEmail(email)
            && (isSigningUp ? HyggeAuth.passwordProblem(password) == nil : !password.isEmpty)
    }

    private var emailForm: some View {
        VStack(spacing: 12) {
            TextField("Email", text: $email)
                .textContentType(.emailAddress)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(.horizontal, 17).padding(.vertical, 13)
                .background(HyggeTheme.card, in: Capsule())
                .overlay(Capsule().stroke(HyggeTheme.hairline, lineWidth: 1))
                .accessibilityLabel("Email address")
            SecureField("Password", text: $password)
                .textContentType(isSigningUp ? .newPassword : .password)
                .padding(.horizontal, 17).padding(.vertical, 13)
                .background(HyggeTheme.card, in: Capsule())
                .overlay(Capsule().stroke(HyggeTheme.hairline, lineWidth: 1))
                .accessibilityLabel("Password")
            if isSigningUp {
                Text("At least \(HyggeAuth.passwordMinLength) characters. A short phrase works well.")
                    .font(.caption)
                    .foregroundStyle(HyggeTheme.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Button {
                Task { await submitEmail() }
            } label: {
                Group {
                    if isWorking { ProgressView().tint(.white) }
                    else { Text(isSigningUp ? "Create account" : "Sign in").font(.body.weight(.semibold)) }
                }
                .frame(maxWidth: .infinity).padding(.vertical, 16)
                .background(HyggeTheme.emberDeep, in: Capsule())
                .foregroundStyle(.white)
            }
            .buttonStyle(.plain)
            .disabled(!formIsValid || isWorking)
            .opacity(formIsValid && !isWorking ? 1 : 0.45)
            .accessibilityLabel(isSigningUp ? "Create account with email" : "Sign in with email")
        }
    }

    private func submitEmail() async {
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            if isSigningUp {
                try await store.backend.emailSignUp(email: email, password: password)
            } else {
                try await store.backend.emailSignIn(email: email, password: password)
            }
            password = ""
            onAuthenticated()
        } catch {
            errorMessage = AuthCopy.message(for: error)
        }
    }

    private func handleApple(_ result: Result<ASAuthorization, Error>,
                             complete: @escaping (String, String?, String?) async throws -> Void) {
        switch result {
        case .failure(let error):
            // Backing out of the Apple sheet is not an error to report.
            if (error as? ASAuthorizationError)?.code != .canceled {
                errorMessage = "Apple sign-in didn't work just now. Try again, or use email below."
            }
        case .success(let authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let tokenData = credential.identityToken,
                  let identityToken = String(data: tokenData, encoding: .utf8) else {
                errorMessage = "Apple sign-in didn't work just now. Try again, or use email below."
                return
            }
            let displayName = credential.fullName.map {
                PersonNameComponentsFormatter().string(from: $0)
            }.flatMap { $0.isEmpty ? nil : $0 }
            let nonce = currentNonce
            isWorking = true
            errorMessage = nil
            Task {
                defer { isWorking = false }
                do {
                    try await complete(identityToken, nonce, displayName)
                    password = ""
                    onAuthenticated()
                } catch {
                    errorMessage = AuthCopy.message(for: error)
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

/// "Add a login method" for Profile (Brief 00): list, link, and
/// remove ways in — always while signed in, never the last one.
struct LoginMethodsContent: View {
    @Environment(AppStore.self) private var store
    @State private var methods: [LinkedLoginMethod] = []
    @State private var linkEmail = ""
    @State private var linkPassword = ""
    @State private var currentPassword = ""
    @State private var newPassword = ""
    @State private var message: String?
    @State private var isWorking = false
    @State private var currentNonce: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if methods.isEmpty {
                Text("Sign in to see your login methods.")
                    .font(.subheadline).foregroundStyle(HyggeTheme.secondary)
            }
            ForEach(methods) { method in
                HStack(spacing: 10) {
                    Image(systemName: method.method == .apple ? "applelogo" : "envelope")
                        .foregroundStyle(HyggeTheme.sageDeep)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(method.method.label).font(.subheadline.weight(.semibold)).foregroundStyle(HyggeTheme.ink)
                        if let email = method.email {
                            Text(email).font(.caption).foregroundStyle(HyggeTheme.secondary)
                        }
                    }
                    Spacer()
                    Button("Remove", role: .destructive) {
                        Task { await remove(method) }
                    }
                    .font(.caption.weight(.semibold))
                    .disabled(!HyggeAuth.canRemoveLoginMethod(methodCount: methods.count) || isWorking)
                    .opacity(HyggeAuth.canRemoveLoginMethod(methodCount: methods.count) ? 1 : 0.4)
                    .accessibilityLabel("Remove \(method.method.label) sign-in")
                }
            }
            if methods.count == 1 {
                Text("Add another way to sign in before removing this one — an account always keeps a way back in.")
                    .font(.caption).foregroundStyle(HyggeTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Divider()
            Text("Add a login method").font(.subheadline.weight(.semibold)).foregroundStyle(HyggeTheme.ink)
            SignInWithAppleButton(.signIn) { request in
                let nonce = AuthView.makeNonce()
                currentNonce = nonce
                request.requestedScopes = [.email]
                request.nonce = nonce
            } onCompletion: { result in
                handleAppleLink(result)
            }
            .signInWithAppleButtonStyle(.black)
            .frame(height: 46)
            .clipShape(Capsule())
            .accessibilityLabel("Add Sign in with Apple")

            TextField("Email", text: $linkEmail)
                .textContentType(.emailAddress)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityLabel("Email to add")
            SecureField("New password", text: $linkPassword)
                .textContentType(.newPassword)
                .accessibilityLabel("Password for the email to add")
            Button("Add email and password") { Task { await addEmail() } }
                .font(.subheadline.weight(.semibold))
                .disabled(!HyggeAuth.isPlausibleEmail(linkEmail) || HyggeAuth.passwordProblem(linkPassword) != nil || isWorking)

            if methods.contains(where: { $0.method == .email }) {
                Divider()
                Text("Change password").font(.subheadline.weight(.semibold)).foregroundStyle(HyggeTheme.ink)
                SecureField("Current password", text: $currentPassword)
                    .textContentType(.password)
                    .accessibilityLabel("Current password")
                SecureField("New password", text: $newPassword)
                    .textContentType(.newPassword)
                    .accessibilityLabel("New password")
                Button("Change password") { Task { await changePassword() } }
                    .font(.subheadline.weight(.semibold))
                    .disabled(currentPassword.isEmpty || HyggeAuth.passwordProblem(newPassword) != nil || isWorking)
            }

            if let message {
                Text(message).font(.caption).foregroundStyle(HyggeTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button("Sign out") { Task { await store.signOut() } }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HyggeTheme.emberDeep)
        }
        .task { await load() }
    }

    private func load() async {
        if let loaded = try? await store.backend.fetchLoginMethods() { methods = loaded }
    }

    private func addEmail() async {
        isWorking = true
        defer { isWorking = false }
        do {
            methods = try await store.backend.linkEmail(email: linkEmail, password: linkPassword)
            linkEmail = ""; linkPassword = ""
            message = "Email sign-in added. Either way in opens this same account."
        } catch {
            message = AuthCopy.message(for: error)
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

    private func changePassword() async {
        isWorking = true
        defer { isWorking = false }
        do {
            try await store.backend.changePassword(current: currentPassword, new: newPassword)
            currentPassword = ""; newPassword = ""
            message = "Password changed. Other devices will need to sign in again."
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
