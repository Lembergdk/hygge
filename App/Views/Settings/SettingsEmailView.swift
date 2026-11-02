import SwiftUI

struct SettingsEmailView: View {
    @Environment(AppStore.self) private var store
    @State private var allocating = false
    @State private var error: String?
    @State private var copied = false
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
    var body: some View {
        SettingsPage(title: "Filed mail") {
            Text(mail.senderDomain).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
            Text(mail.subject.isEmpty ? "Email summary" : mail.subject).font(.title2.bold()).foregroundStyle(HyggeTheme.ink)
            Text(mail.summary).foregroundStyle(HyggeTheme.ink).textSelection(.enabled)
            ForEach(Array(mail.actionableItems.enumerated()), id: \.offset) { _, item in
                Text(item).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
            }
        }
    }
}
