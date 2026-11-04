import SwiftUI

struct CredentialSaveSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let siteName: String
    let domain: String
    var onFinish: (Bool) -> Void = { _ in }
    @State private var username = ""
    @State private var secret = ""
    @State private var saving = false
    @State private var saved = false
    @State private var failed = false
    @State private var finished = false
    @State private var showPassword = false
    @FocusState private var field: Field?
    private enum Field { case username, password }
    private var isUpdating: Bool { store.credential(forDomain: domain) != nil }
    private var canSave: Bool {
        !saving && !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !secret.isEmpty
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    if saved {
                        VStack(spacing: 22) {
                            Image(systemName: "checkmark.circle.fill").font(.system(size: 58))
                                .foregroundStyle(
                                    HyggeTheme.sageDeep)
                            VStack(spacing: 8) {
                                Text("Login saved").font(.title.bold())
                                Text("Ready for the next time Hygge needs to sign in.")
                                    .font(.body).foregroundStyle(HyggeTheme.secondary)
                                    .multilineTextAlignment(.center)
                            }
                            VStack(spacing: 7) {
                                Text(siteName).font(.headline)
                                Text(domain).font(.subheadline).foregroundStyle(
                                    HyggeTheme.secondary)
                                Text(username).font(.body).padding(.top, 8)
                            }.frame(maxWidth: .infinity).settingsSurface()
                        }.frame(maxWidth: .infinity).padding(.top, 56)
                    } else {
                        SiteSettingsIdentity(name: siteName, domain: domain)
                        Text("Use the login you already have for \(siteName).")
                            .font(.title3.weight(.semibold)).fixedSize(
                                horizontal: false, vertical: true)
                        VStack(alignment: .leading, spacing: 16) {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Email or username").font(.subheadline.weight(.semibold))
                                TextField("Your login for \(siteName)", text: $username)
                                    .accessibilityLabel("Email or username").textContentType(
                                        .username
                                    )
                                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                                    .focused($field, equals: .username).submitLabel(.next).onSubmit
                                {
                                    field = .password
                                }
                            }.padding(.vertical, 4)
                            Divider()
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Password").font(.subheadline.weight(.semibold))
                                HStack {
                                    Group {
                                        if showPassword {
                                            TextField("Enter your password", text: $secret)
                                                .textInputAutocapitalization(
                                                    .never
                                                ).autocorrectionDisabled()
                                        } else {
                                            SecureField("Enter your password", text: $secret)
                                        }
                                    }.accessibilityLabel("Password").textContentType(.password)
                                        .focused(
                                            $field, equals: .password
                                        ).submitLabel(.done).onSubmit { field = nil }
                                    Button {
                                        showPassword.toggle()
                                    } label: {
                                        Image(systemName: showPassword ? "eye.slash" : "eye").frame(
                                            width: 44, height: 44)
                                    }
                                    .foregroundStyle(HyggeTheme.secondary).accessibilityLabel(
                                        showPassword ? "Hide password" : "Show password")
                                }
                            }
                        }.settingsSurface().disabled(saving)
                        if failed {
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: "exclamationmark.circle.fill")
                                VStack(alignment: .leading, spacing: 5) {
                                    Text("We couldn’t confirm the save").font(
                                        .subheadline.weight(.semibold))
                                    Text("Enter your password again to retry.").font(.subheadline)
                                }
                            }.foregroundStyle(HyggeTheme.emberDeep).padding(16)
                                .frame(maxWidth: .infinity, alignment: .leading).background(
                                    HyggeTheme.peach, in: RoundedRectangle(cornerRadius: 16))
                        }
                        Label("Your password won’t appear in chat.", systemImage: "lock")
                            .font(.footnote).foregroundStyle(HyggeTheme.secondary)
                    }
                }.padding(22)
            }
            .background(HyggeTheme.paper)
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 12) {
                    Button {
                        if saved { finish(true) } else { Task { await save() } }
                    } label: {
                        HStack(spacing: 10) {
                            if saving { ProgressView().tint(HyggeTheme.onSage) }
                            Text(saved ? "Done" : saving ? "Saving…" : "Save login")
                        }
                    }.buttonStyle(SettingsActionStyle())
                        .disabled(!saved && !canSave)
                        .opacity(!saved && !saving && !canSave ? 0.45 : 1)
                }.padding(.horizontal, 22).padding(.vertical, 18).background(HyggeTheme.paper)
            }
            .navigationTitle(saved ? "" : isUpdating ? "Update login" : "Save your login")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if !saved {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Cancel") { finish(false) }.disabled(saving)
                    }
                }
            }
            .toolbarBackground(HyggeTheme.paper, for: .navigationBar)
            .foregroundStyle(HyggeTheme.ink).fontDesign(.rounded).tint(HyggeTheme.sageDeep)
            .interactiveDismissDisabled(saving)
            .onAppear {
                if isUpdating && username.isEmpty {
                    username = store.credential(forDomain: domain)?.username ?? ""
                }
            }
            .onDisappear {
                secret = ""
                if !finished {
                    finished = true
                    onFinish(saved)
                }
            }
        }
    }
    private func save() async {
        guard !saving, !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            !secret.isEmpty
        else { return }
        field = nil
        saving = true
        failed = false
        let password = secret
        secret = ""
        saved = await store.addCredential(
            domain: domain, username: username.trimmingCharacters(in: .whitespacesAndNewlines),
            secret: password)
        saving = false
        if !saved {
            failed = true
            field = .password
            AccessibilityNotification.Announcement(
                "We couldn’t confirm the save. Enter your password again to retry."
            ).post()
        }
    }
    private func finish(_ didSave: Bool) {
        guard !finished else { return }
        finished = true
        onFinish(didSave)
        dismiss()
    }
}
