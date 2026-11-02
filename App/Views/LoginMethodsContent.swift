import SwiftUI
import AuthenticationServices

struct LoginMethodsContent: View {
    @Environment(AppStore.self) private var store
    @State private var methods: [LinkedLoginMethod] = []
    @State private var loaded = false
    @State private var linkEmail = ""
    @State private var message: String?
    @State private var isWorking = false
    @State private var currentNonce: String?
    @State private var editingMethodID: String?
    @State private var password = ""
    @State private var reauthenticationNeeded = false
    @State private var passwordConfirmation: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            Text("Connected").font(.title3.weight(.bold)).foregroundStyle(HyggeTheme.ink)
            if !loaded {
                if message == nil { ProgressView() }
                else { Button("Try again") { Task { await load() } } }
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(methods.enumerated()), id: \.element.id) { index, method in
                        if index > 0 { Divider().overlay(HyggeTheme.hairline).padding(.vertical, 16) }
                        methodRow(method)
                        if method.method == .email && method.emailVerified {
                            Divider().overlay(HyggeTheme.hairline).padding(.vertical, 16)
                            passwordSection(method)
                        }
                    }
                }.settingsSurface()
                if let passwordConfirmation {
                    Label(passwordConfirmation, systemImage: "checkmark.circle.fill")
                        .font(.subheadline).foregroundStyle(HyggeTheme.sageDeep)
                        .accessibilityAddTraits(.updatesFrequently)
                }
                if !methods.contains(where: { $0.method == .apple }) ||
                    !methods.contains(where: { $0.method == .email && $0.emailVerified }) {
                    Text("Add more").font(.title3.weight(.bold)).foregroundStyle(HyggeTheme.ink)
                }
                if !methods.contains(where: { $0.method == .apple }) {
                    SignInWithAppleButton(.signIn) { request in
                        let nonce = SignInCard.makeNonce()
                        currentNonce = nonce
                        request.requestedScopes = [.email]
                        request.nonce = nonce
                    } onCompletion: { handleAppleLink($0) }
                    .signInWithAppleButtonStyle(.black).frame(height: 48).clipShape(Capsule())
                    .accessibilityLabel("Add Sign in with Apple")
                }
                // Only the first email needs an entry point. Existing verified emails
                // get password controls, without an "Add another email" row.
                if !methods.contains(where: { $0.method == .email && $0.emailVerified }) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Add email sign-in").font(.headline).foregroundStyle(HyggeTheme.ink)
                        TextField("Email address", text: $linkEmail)
                            .textContentType(.emailAddress).keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().settingsField()
                        Button("Verify email") { Task { await sendLink(to: linkEmail) } }
                            .buttonStyle(SettingsActionStyle())
                            .disabled(!HyggeAuth.isPlausibleEmail(linkEmail))
                    }
                }
            }
            if let error = store.magicLinkError { Text(error).font(.caption).foregroundStyle(HyggeTheme.secondary) }
            if let message { Text(message).font(.caption).foregroundStyle(HyggeTheme.secondary) }
        }
        .disabled(isWorking)
        .overlay(alignment: .topTrailing) { if isWorking { ProgressView() } }
        .task {
            await load()
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
        .onDisappear { password = "" }
        .task(id: passwordConfirmation) {
            guard passwordConfirmation != nil else { return }
            try? await Task.sleep(for: .seconds(4))
            if !Task.isCancelled { passwordConfirmation = nil }
        }
    }

    private func methodRow(_ method: LinkedLoginMethod) -> some View {
        HStack(spacing: 14) {
            Image(systemName: method.method == .apple ? "applelogo" : "envelope")
                .font(.title2).foregroundStyle(HyggeTheme.ink).frame(width: 32)
            VStack(alignment: .leading, spacing: 4) {
                if method.method == .apple { Text("Apple").font(.headline) }
                if let email = method.email {
                    Text(email).font(method.method == .apple ? .subheadline : .body)
                        .foregroundStyle(method.method == .apple ? HyggeTheme.secondary : HyggeTheme.ink)
                        .textSelection(.enabled)
                }
            }.foregroundStyle(HyggeTheme.ink)
            Spacer(minLength: 0)
            Image(systemName: "checkmark.circle.fill").foregroundStyle(HyggeTheme.sageDeep)
                .accessibilityLabel("Connected")
        }
        .contextMenu {
            if HyggeAuth.canRemoveLoginMethod(methodCount: methods.count) {
                Button("Remove login", role: .destructive) { Task { await remove(method) } }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityActions {
            if HyggeAuth.canRemoveLoginMethod(methodCount: methods.count) {
                Button("Remove login") { Task { await remove(method) } }
            }
        }
    }

    @ViewBuilder private func passwordSection(_ method: LinkedLoginMethod) -> some View {
        if editingMethodID == method.id {
            VStack(alignment: .leading, spacing: 12) {
                Text("New password").font(.subheadline.weight(.semibold)).foregroundStyle(HyggeTheme.ink)
                AccountPasswordField(title: "At least 15 characters", password: $password)
                if reauthenticationNeeded {
                    Button("Confirm with an email link") { Task { await sendLink(to: method.email ?? "") } }
                        .buttonStyle(SettingsActionStyle())
                } else {
                    Button(method.hasPassword ? "Update password" : "Create password") {
                        Task { await savePassword(for: method) }
                    }.buttonStyle(SettingsActionStyle())
                        .disabled(!HyggeAuth.isValidPassword(password))
                        .opacity(HyggeAuth.isValidPassword(password) ? 1 : 0.5)
                }
                Button("Cancel") { closeEditor() }
                    .font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                    .frame(maxWidth: .infinity, minHeight: 44).buttonStyle(.plain)
            }
        } else {
            Button {
                editingMethodID = method.id
                password = ""
                message = nil
                reauthenticationNeeded = false
            } label: {
                HStack(spacing: 14) {
                    Image(systemName: "key").font(.title2).frame(width: 32)
                    Text(method.hasPassword ? "Password" : "Create password")
                        .foregroundStyle(method.hasPassword ? HyggeTheme.ink : HyggeTheme.sageDeep)
                    Spacer()
                    if method.hasPassword { Text("Change").font(.subheadline) }
                    Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                }.foregroundStyle(HyggeTheme.sageDeep).frame(minHeight: 44)
            }.buttonStyle(.plain)
        }
    }

    private func closeEditor() {
        editingMethodID = nil
        password = ""
        reauthenticationNeeded = false
        message = nil
    }

    private func savePassword(for method: LinkedLoginMethod) async {
        isWorking = true
        message = nil
        defer { isWorking = false }
        do {
            methods = try await store.backend.setEmailPassword(methodID: method.id, password: password)
            closeEditor()
            passwordConfirmation = method.hasPassword ? "Password updated" : "Password created"
        } catch AuthClientError.reauthenticationRequired {
            reauthenticationNeeded = true
            message = AuthCopy.message(for: AuthClientError.reauthenticationRequired)
        } catch { message = AuthCopy.message(for: error) }
    }

    private func load() async {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--settings-preview") {
            let preview = UserDefaults.standard.string(forKey: "passwordPreviewState") ?? "none"
            methods = [LinkedLoginMethod(id: "apple", method: .apple, email: "m@example.com"),
                       LinkedLoginMethod(id: "email", method: .email, email: "m@example.com", emailVerified: true, hasPassword: preview == "created")]
            if let provider = UserDefaults.standard.string(forKey: "loginMethodsPreviewProvider") {
                methods = methods.filter { $0.method.rawValue == provider }
            }
            if preview == "editing" { editingMethodID = "email" }
            if preview == "created" { passwordConfirmation = "Password created" }
            loaded = true
            return
        }
        #endif
        message = nil
        do { methods = try await store.backend.fetchLoginMethods(); loaded = true }
        catch { message = "Your logins couldn’t be loaded. Try again when you’re connected." }
    }

    private func sendLink(to email: String) async {
        isWorking = true
        store.magicLinkError = nil
        defer { isWorking = false }
        do { message = try await store.backend.requestMagicLink(email: email) }
        catch { message = AuthCopy.message(for: error) }
    }

    private func consumeLink(_ token: String) async {
        isWorking = true
        defer { isWorking = false }
        do {
            if let updated = try await store.backend.consumeMagicLink(token: token) {
                methods = updated
                linkEmail = ""
                message = reauthenticationNeeded ? "Confirmed. You can set your password now." : "Email sign-in added."
                reauthenticationNeeded = false
                store.magicLinkError = nil
            }
        } catch { store.magicLinkError = AuthCopy.message(for: error) }
    }

    private func remove(_ method: LinkedLoginMethod) async {
        isWorking = true
        defer { isWorking = false }
        do {
            methods = try await store.backend.unlinkLoginMethod(id: method.id)
            if editingMethodID == method.id { closeEditor() }
            message = "Login removed."
        } catch { message = AuthCopy.message(for: error) }
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
            do { methods = try await store.backend.linkApple(identityToken: identityToken, nonce: nonce) }
            catch { message = AuthCopy.message(for: error) }
        }
    }
}
