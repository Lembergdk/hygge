import SwiftUI

struct EmailPreferencesView: View {
    @Environment(AppStore.self) private var store
    @State private var address = ""
    @State private var error: String?
    @State private var busy = false
    @State private var verification: OwnEmailAddress?
    @State private var removing: OwnEmailAddress?
    var body: some View {
        SettingsPage(title: "Email preferences") {
            Text("My email addresses").font(.title3.bold())
            Text(
                "Let Hygge recognize mail from you. Added addresses need verification before they can send instructions."
            ).foregroundStyle(HyggeTheme.secondary)
            if let error {
                Label(error, systemImage: "exclamationmark.circle").foregroundStyle(
                    HyggeTheme.emberDeep)
            }
            ForEach(store.ownEmailAddresses) { own in
                VStack(alignment: .leading, spacing: 10) {
                    Text(own.address).font(.subheadline.weight(.semibold)).textSelection(.enabled)
                    Label(
                        own.verified ? "Verified" : "Verification needed",
                        systemImage: own.verified ? "checkmark.circle" : "clock"
                    )
                    .font(.caption).foregroundStyle(
                        own.verified ? HyggeTheme.sageDeep : HyggeTheme.secondary)
                    if own.source == "account" {
                        Text("From your account. Manage this address in Logins.").font(.caption)
                            .foregroundStyle(HyggeTheme.secondary)
                    } else {
                        HStack {
                            if !own.verified {
                                Button("Verify address") { add(own.address) }.frame(minHeight: 44)
                            }
                            Spacer()
                            Button("Remove", role: .destructive) { removing = own }.frame(
                                minHeight: 44)
                        }.font(.subheadline)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).settingsSurface()
            }
            VStack(alignment: .leading, spacing: 14) {
                TextField("Email address", text: $address).keyboardType(.emailAddress)
                    .textContentType(.emailAddress)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().settingsField()
                Button("Add my address") { add(address) }.buttonStyle(
                    SettingsActionStyle(filled: false)
                )
                .disabled(!HyggeAuth.isPlausibleEmail(HyggeAuth.normalizeEmail(address)))
            }
            NavigationLink {
                IgnoredEmailDomainsView()
            } label: {
                SettingsRow(
                    title: "Ignored sender domains", icon: "bell.slash",
                    subtitle: "Mail kept in history without work suggestions")
            }.buttonStyle(.plain)
        }.disabled(busy)
            .task { await refresh() }.refreshable { await refresh() }
            .sheet(item: $verification) {
                EmailAddressVerificationView(address: $0).presentationDragIndicator(.visible)
            }
            .alert(
                "Remove this personal address?",
                isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })
            ) {
                if let own = removing {
                    Button("Remove address", role: .destructive) {
                        busy = true
                        Task {
                            if !((await store.removeOwnEmailAddress(own.address))) {
                                error = "Couldn’t remove the address. Please try again."
                            }
                            busy = false
                        }
                    }
                }
                Button("Cancel", role: .cancel) { removing = nil }
            } message: {
                Text(
                    "Future mail from this address won’t be recognized through this personal-address entry. Existing emails won’t be rerun or deleted."
                )
            }
    }
    private func refresh() async {
        do {
            try await store.refreshOwnEmailAddresses()
            error = nil
        } catch { self.error = "Couldn’t load your addresses. Pull to refresh and try again." }
    }
    private func add(_ value: String) {
        busy = true
        error = nil
        Task {
            do {
                let own = try await store.addOwnEmailAddress(HyggeAuth.normalizeEmail(value))
                if !own.verified { verification = own }
                address = ""
            } catch { self.error = "Couldn’t add this address. Check it and try again." }
            busy = false
        }
    }
}

struct EmailAddressVerificationView: View {
    let address: OwnEmailAddress
    @Environment(AppStore.self) private var store
    @State private var checked = false
    @State private var error: String?
    private var verified: Bool {
        store.ownEmailAddresses.contains { $0.address == address.address && $0.verified }
    }
    var body: some View {
        NavigationStack {
            SettingsPage(title: verified ? "Address verified" : "Verify your address") {
                Text(address.address).font(.headline).textSelection(.enabled)
                if verified {
                    Label(
                        "Hygge can recognize authenticated mail from this address as yours.",
                        systemImage: "checkmark.circle"
                    ).foregroundStyle(HyggeTheme.sageDeep)
                } else if let subject = address.verificationSubject,
                    let recipient = store.hyggeEmailAddress?.address
                {
                    Text(
                        "Send a new email from this address to your Hygge address. Use the exact subject below; the body can be empty."
                    ).foregroundStyle(HyggeTheme.secondary)
                    VStack(alignment: .leading, spacing: 12) {
                        Text("To").font(.caption)
                        Text(recipient).textSelection(.enabled)
                        Button("Copy recipient") { UIPasteboard.general.string = recipient }.frame(
                            minHeight: 44)
                        Text("Subject").font(.caption)
                        Text(subject).font(.subheadline).textSelection(.enabled)
                        Button("Copy verification subject") {
                            UIPasteboard.general.string = subject
                        }.frame(minHeight: 44)
                    }.settingsSurface()
                    Text(
                        "This verification expires in 24 hours. Hygge won’t send an email or replay older messages."
                    ).font(.footnote).foregroundStyle(HyggeTheme.secondary)
                    Button("Check verification") {
                        Task {
                            do {
                                try await store.refreshOwnEmailAddresses()
                                checked = true
                            } catch {
                                self.error = "Couldn’t check verification. Please try again."
                            }
                        }
                    }.buttonStyle(SettingsActionStyle())
                    if checked && !verified {
                        Text(
                            "Verification hasn’t arrived yet. Check the From address and exact subject, then try again."
                        ).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                    }
                }
                if let error { Text(error).foregroundStyle(HyggeTheme.emberDeep) }
            }
        }
    }
}

struct IgnoredEmailDomainsView: View {
    @Environment(AppStore.self) private var store
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        SettingsPage(title: "Ignored sender domains") {
            Text(
                "Their mail stays in history. Hygge won’t check it for work or show journal entries and suggestions."
            ).foregroundStyle(HyggeTheme.secondary)
            if store.ignoredSenderDomains.isEmpty { Text("No domains ignored.") }
            ForEach(store.ignoredSenderDomains, id: \.self) { domain in
                VStack(alignment: .leading, spacing: 10) {
                    Text(domain).font(.headline)
                    Button("Stop ignoring this domain") {
                        busy = true
                        Task {
                            if !(await store.decideEmailSender(domain: domain, choice: "work")) {
                                error = "Couldn’t update this preference. Please try again."
                            }
                            busy = false
                        }
                    }.frame(minHeight: 44).foregroundStyle(HyggeTheme.sageDeep)
                }.frame(maxWidth: .infinity, alignment: .leading).settingsSurface()
            }
            if let error { Text(error).foregroundStyle(HyggeTheme.emberDeep) }
        }.disabled(busy).task { await store.refreshHyggeEmail() }
    }
}
