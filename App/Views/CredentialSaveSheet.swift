import SwiftUI

/// "Save this login" sheet (Brief 03). Shown the moment the user
/// confirms they already have a profile on a site, and from any site
/// row in the profile hub. The site is fixed (never a free-typed
/// domain); the password goes once to the safe store and is never
/// kept on this phone or shown again — confirmation is the site and
/// username only.
struct CredentialSaveSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let siteName: String
    let domain: String
    /// Called exactly once when the sheet closes: true if a login was
    /// saved, false if the user skipped. Defaults to just dismissing.
    var onFinish: (Bool) -> Void = { _ in }

    @State private var username = ""
    @State private var secret = ""
    @State private var saving = false
    @State private var saved = false
    @State private var failed = false
    @State private var finished = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Site") {
                        Text(domain).foregroundStyle(.secondary)
                    }
                    Text("This is the login you already use on \(siteName). Hygge keeps it safely and types it only into \(siteName) itself — it is never shown in chat or kept on this phone.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if saved {
                    Section {
                        Label("Login for \(domain) saved safely", systemImage: "checkmark.shield")
                        LabeledContent("Signed in as") { Text(username) }
                        Button("Done") { finish(true) }
                            .buttonStyle(.borderedProminent)
                    }
                } else {
                    Section("Your \(siteName) login") {
                        TextField("Username / email", text: $username)
                            .textContentType(.username)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        SecureField("Password", text: $secret)
                            .textContentType(.password)
                    }
                    if failed {
                        Section {
                            Text("That login could not be saved just now. Nothing was stored — please try again.")
                                .font(.footnote).foregroundStyle(.red)
                        }
                    }
                    Section {
                        Button(saving ? "Saving safely…" : "Save login safely") {
                            Task { await save() }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(saving || username.isEmpty || secret.isEmpty)
                        Button("Not now") { finish(false) }
                            .disabled(saving)
                    }
                }
            }
            .navigationTitle("Save your login")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(saving)
            .onDisappear {
                secret = ""
                if !finished { finished = true; onFinish(saved) }
            }
        }
    }

    private func save() async {
        saving = true
        failed = false
        let password = secret
        secret = ""
        saved = await store.addCredential(domain: domain, username: username, secret: password)
        saving = false
        if !saved { failed = true }
    }

    private func finish(_ didSave: Bool) {
        guard !finished else { return }
        finished = true
        onFinish(didSave)
        dismiss()
    }
}
