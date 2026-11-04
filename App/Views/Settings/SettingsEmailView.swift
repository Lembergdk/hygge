import SwiftUI

struct SettingsEmailView: View {
    @Environment(AppStore.self) private var store
    @State private var allocating = false
    @State private var error: String?
    @State private var copied = false
    @State private var showPlus = false
    @State private var customName = ""
    @State private var savingName = false
    @State private var nameError: String?
    @State private var nameSaved = false
    var body: some View {
        SettingsPage(title: "Hygge email") {
            SettingsArtwork(name: "SettingsEmail", width: 160, height: 125).frame(maxWidth: .infinity)
            Text(store.hyggeEmailAddress == nil ? "A little less inbox." : "Your work mail, handled.")
                .font(.system(.title2, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink)
                .frame(maxWidth: .infinity).multilineTextAlignment(.center)
            if let address = store.hyggeEmailAddress {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Your Hygge address").font(.caption).foregroundStyle(HyggeTheme.secondary)
                    HStack {
                        Text(address.address).font(.headline).foregroundStyle(HyggeTheme.ink).textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                        Button {
                            UIPasteboard.general.string = address.address; copied = true
                        } label: { Image(systemName: copied ? "checkmark" : "doc.on.doc").frame(width: 44, height: 44) }
                            .accessibilityLabel(copied ? "Address copied" : "Copy Hygge email address")
                    }
                    Label("Ready", systemImage: "checkmark.circle.fill").font(.caption).foregroundStyle(HyggeTheme.sageDeep)
                }.settingsSurface()
                Text("Forward emails from work sites here. Hygge will file the useful bits.")
                    .font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                customNameSection(address)
                if !store.ignoredSenderDomains.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Ignored senders").font(.title3.bold()).foregroundStyle(HyggeTheme.ink)
                        Text("Their mail is filed silently — no journal line, no suggestions.")
                            .font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                        ForEach(store.ignoredSenderDomains, id: \.self) { domain in
                            HStack(spacing: 12) {
                                SiteLogoTile(domain: domain, name: domain, size: 32)
                                Text(domain).font(.subheadline).foregroundStyle(HyggeTheme.ink)
                                Spacer(minLength: 0)
                                Button("Stop ignoring") {
                                    Task { await store.decideEmailSender(domain: domain, choice: "work") }
                                }
                                .font(.subheadline.weight(.medium)).foregroundStyle(HyggeTheme.sageDeep)
                                .frame(minHeight: 44).buttonStyle(.plain)
                            }
                        }
                    }.settingsSurface()
                }
                filedMail
            } else {
                Text("An email address for the work Hygge handles.").foregroundStyle(HyggeTheme.secondary)
                explanation("Handle signup emails", icon: "envelope.badge", text: "Hygge completes the email steps for approved sites.")
                explanation("Forward work emails", icon: "arrowshape.turn.up.right", text: "Send gig-site mail here for Hygge to sort.")
                explanation("Keep the useful bits", icon: "doc.text", text: "Read short summaries instead of digging through mail.")
                Button {
                    allocating = true; error = nil
                    Task {
                        await store.chooseHyggeEmailAddress()
                        allocating = false
                        if store.hyggeEmailAddress == nil { error = "Your address couldn’t be created just now. Try again." }
                    }
                } label: {
                    if allocating { ProgressView() } else { Text("Get a Hygge email address") }
                }.buttonStyle(SettingsActionStyle()).disabled(allocating)
            }
            if let error { Text(error).font(.caption).foregroundStyle(HyggeTheme.secondary) }
        }
        .task { await store.refreshHyggeEmail() }
        .refreshable { await store.refreshHyggeEmail() }
        .sheet(isPresented: $showPlus) {
            NavigationStack { PlusSheetView() }.presentationDragIndicator(.visible)
        }
    }

    /// Plus names the address (sam@usehygge.cc). The numbered
    /// address above keeps working either way — say so plainly.
    @ViewBuilder private func customNameSection(_ address: HyggeEmailAddress) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Your own email name").font(.caption).foregroundStyle(HyggeTheme.secondary)
            if store.plusStore.isPlus {
                if let custom = address.customAddress {
                    HStack {
                        Text(custom).font(.headline).foregroundStyle(HyggeTheme.ink).textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                        Image(systemName: "checkmark.circle.fill").foregroundStyle(HyggeTheme.sageDeep)
                    }
                }
                HStack(spacing: 8) {
                    TextField(address.customAddress == nil ? "yourname" : "Change name", text: $customName)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .keyboardType(.emailAddress)
                        .foregroundStyle(HyggeTheme.ink)
                    Text("@usehygge.cc").font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                }
                Button {
                    savingName = true; nameError = nil; nameSaved = false
                    let name = customName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                    Task {
                        switch await store.setCustomEmailName(name) {
                        case .set:
                            nameSaved = true; customName = ""
                        case .taken:
                            nameError = "That name is taken — try another."
                        case .invalid:
                            nameError = "Names are 3–30 letters or numbers, with dots or dashes inside."
                        case .plusRequired:
                            nameError = "Custom names come with Plus."
                        case .failed:
                            nameError = "That couldn't be saved just now. Try again."
                        }
                        savingName = false
                    }
                } label: {
                    if savingName { ProgressView() } else { Text(address.customAddress == nil ? "Use this name" : "Change name") }
                }.buttonStyle(SettingsActionStyle(filled: false))
                    .disabled(savingName || customName.trimmingCharacters(in: .whitespacesAndNewlines).count < 3)
                if let nameError {
                    Text(nameError).font(.caption).foregroundStyle(HyggeTheme.secondary)
                } else if nameSaved {
                    Text("Saved. Mail to your name arrives just like mail to the numbered address.")
                        .font(.caption).foregroundStyle(HyggeTheme.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text("The numbered address keeps working too.")
                    .font(.caption).foregroundStyle(HyggeTheme.secondary)
            } else if let custom = address.customAddress {
                Text(custom).font(.headline).foregroundStyle(HyggeTheme.ink).textSelection(.enabled)
                Text("Your name keeps receiving mail. Changing it comes with Plus.")
                    .font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("With Plus, your address can carry your name — like sam@usehygge.cc.")
                    .font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button { showPlus = true } label: {
                    HStack(spacing: 6) {
                        Text("See Hygge Plus").font(.subheadline.weight(.semibold))
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(HyggeTheme.sageDeep)
                    .frame(minHeight: 44).contentShape(Rectangle())
                }
            }
        }.settingsSurface()
    }
    private var filedMail: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text("Filed mail").font(.title3.bold())
                Spacer()
                Text("\(store.filedEmailSummaries.count)").font(.subheadline)
            }.foregroundStyle(HyggeTheme.ink)
            if store.filedEmailSummaries.isEmpty {
                Text("Your email summaries will live here.").foregroundStyle(HyggeTheme.secondary)
            }
            ForEach(store.filedEmailSummaries) { mail in
                NavigationLink { FiledEmailDetailView(mail: mail) } label: {
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: "envelope").foregroundStyle(HyggeTheme.secondary).frame(width: 28, height: 32)
                        VStack(alignment: .leading, spacing: 6) {
                            Text(mail.senderDomain).font(.caption.weight(.semibold))
                            Text(mail.subject.isEmpty ? "Mail from \(mail.senderDomain)" : mail.subject).font(.subheadline.weight(.semibold))
                            Text(mail.summary).font(.subheadline).foregroundStyle(HyggeTheme.secondary).lineLimit(3)
                        }.foregroundStyle(HyggeTheme.ink)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(HyggeTheme.secondary)
                    }.padding(.vertical, 6)
                }.buttonStyle(.plain)
                Divider()
            }
        }
    }
    private func explanation(_ title: String, icon: String, text: String) -> some View {
        HStack(alignment: .top, spacing: 16) {
            Image(systemName: icon).font(.title2).frame(width: 30).foregroundStyle(HyggeTheme.secondary)
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.headline).foregroundStyle(HyggeTheme.ink)
                Text(text).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
            }
        }
    }
}

struct FiledEmailDetailView: View {
    let mail: FiledEmailSummary
    @Environment(AppStore.self) private var store
    var body: some View {
        SettingsPage(title: "Filed mail") {
            HStack(spacing: 12) {
                SiteLogoTile(domain: mail.senderDomain, name: mail.senderDomain, size: 40)
                Text(mail.senderDomain).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
            }
            Text(mail.subject.isEmpty ? "Email summary" : mail.subject).font(.title2.bold()).foregroundStyle(HyggeTheme.ink)
            Text(mail.summary).foregroundStyle(HyggeTheme.ink).textSelection(.enabled)
            ForEach(mail.jobs ?? [], id: \.title) { job in
                VStack(alignment: .leading, spacing: 3) {
                    Text(job.title).font(.subheadline.weight(.semibold)).foregroundStyle(HyggeTheme.ink)
                    if !job.detail.isEmpty {
                        Text(job.detail).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                    }
                }
            }
            ForEach(Array(mail.actionableItems.enumerated()), id: \.offset) { _, item in
                Text(item).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
            }
            // The one sender opt-out: everything else is evaluated
            // by default. Ignoring is reversible from the list in
            // Hygge email settings.
            if store.ignoredSenderDomains.contains(mail.senderDomain) {
                Text("You're ignoring this sender — their mail is filed silently.")
                    .font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                Button("Stop ignoring \(mail.senderDomain)") {
                    Task { await store.decideEmailSender(domain: mail.senderDomain, choice: "work") }
                }
                .font(.subheadline.weight(.medium)).foregroundStyle(HyggeTheme.sageDeep)
                .frame(minHeight: 44).buttonStyle(.plain)
            } else if !mail.senderDomain.isEmpty {
                Button("Ignore this sender") {
                    Task { await store.decideEmailSender(domain: mail.senderDomain, choice: "ignore") }
                }
                .font(.subheadline.weight(.medium)).foregroundStyle(HyggeTheme.secondary)
                .frame(minHeight: 44).buttonStyle(.plain)
            }
        }
    }
}
