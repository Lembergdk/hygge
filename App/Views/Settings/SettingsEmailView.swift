import SwiftUI

struct SettingsEmailView: View {
    @Environment(AppStore.self) private var store
    @State private var copied = false
    @State private var allocating = false
    @State private var allocationError: String?
    @State private var showPlus = false
    @State private var customName = ""
    @State private var savingName = false
    @State private var nameError: String?
    @State private var nameSaved = false
    var body: some View {
        SettingsPage(title: "Hygge email") {
            Text("Work-site mail, in one place.").foregroundStyle(HyggeTheme.secondary)
            EmailRefreshStatus()
            if let allocationError { Text(allocationError).foregroundStyle(HyggeTheme.emberDeep) }
            if let address = store.hyggeEmailAddress {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text("Your Hygge address").font(.caption).foregroundStyle(
                            HyggeTheme.secondary)
                        Spacer()
                        Label("Address ready", systemImage: "checkmark.circle.fill").font(.caption)
                            .foregroundStyle(HyggeTheme.sageDeep)
                    }
                    HStack {
                        Text(address.customAddress ?? address.address).font(.headline)
                            .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 8)
                        Button {
                            UIPasteboard.general.string = address.customAddress ?? address.address
                            copied = true
                        } label: {
                            Image(systemName: copied ? "checkmark" : "doc.on.doc").frame(
                                width: 44, height: 44)
                        }.foregroundStyle(HyggeTheme.sageDeep).accessibilityLabel(
                            copied ? "Address copied" : "Copy email address")
                    }
                    Text("Forward work-site mail here for Hygge to summarize.").font(.subheadline)
                        .foregroundStyle(HyggeTheme.secondary)
                }.settingsSurface()
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("Recent email").font(.headline)
                        Spacer()
                        NavigationLink("View history") { EmailHistoryView() }.font(
                            .subheadline.weight(.semibold)
                        ).foregroundStyle(HyggeTheme.sageDeep).frame(minHeight: 44)
                    }
                    ForEach(store.filedEmailSummaries.prefix(2)) { mail in
                        NavigationLink {
                            FiledEmailDetailView(mail: mail)
                        } label: {
                            EmailHistoryRow(mail: mail)
                        }.buttonStyle(.plain)
                        if mail.id != store.filedEmailSummaries.prefix(2).last?.id { Divider() }
                    }
                    if store.filedEmailSummaries.isEmpty && store.emailHasLoaded
                        && store.emailRefreshError == nil
                    {
                        Text("No email received yet.").font(.subheadline).foregroundStyle(
                            HyggeTheme.secondary)
                    }
                }
                NavigationLink {
                    EmailPreferencesView()
                } label: {
                    SettingsRow(
                        title: "Email preferences", icon: "slider.horizontal.3",
                        subtitle: "Your addresses and ignored sender domains")
                }.buttonStyle(.plain)
                customNameSection(address)
            } else if !store.refreshingEmail {
                SettingsArtwork(name: "SettingsEmail", width: 160, height: 125).frame(
                    maxWidth: .infinity)
                Text("An email address for the work Hygge handles.").foregroundStyle(
                    HyggeTheme.secondary)
                Button {
                    allocating = true
                    Task {
                        allocationError = nil
                        await store.chooseHyggeEmailAddress()
                        allocating = false
                        if store.hyggeEmailAddress == nil {
                            allocationError = "Couldn’t create your address. Please try again."
                        }
                    }
                } label: {
                    if allocating { ProgressView() } else { Text("Get a Hygge email address") }
                }
                .buttonStyle(SettingsActionStyle()).disabled(allocating)
            }
        }.task { await store.refreshHyggeEmail() }.refreshable { await store.refreshHyggeEmail() }
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
                        Text(custom).font(.headline).foregroundStyle(HyggeTheme.ink).textSelection(
                            .enabled
                        )
                        .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                        Image(systemName: "checkmark.circle.fill").foregroundStyle(
                            HyggeTheme.sageDeep)
                    }
                }
                HStack(spacing: 8) {
                    TextField(
                        address.customAddress == nil ? "yourname" : "Change name", text: $customName
                    )
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .keyboardType(.emailAddress)
                    .foregroundStyle(HyggeTheme.ink)
                    Text("@usehygge.cc").font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                }
                Button {
                    savingName = true
                    nameError = nil
                    nameSaved = false
                    let name = customName.trimmingCharacters(in: .whitespacesAndNewlines)
                        .lowercased()
                    Task {
                        switch await store.setCustomEmailName(name) {
                        case .set:
                            nameSaved = true
                            customName = ""
                        case .taken:
                            nameError = "That name is taken — try another."
                        case .invalid:
                            nameError =
                                "Names are 3–30 letters or numbers, with dots or dashes inside."
                        case .plusRequired:
                            nameError = "Custom names come with Plus."
                        case .failed:
                            nameError = "That couldn't be saved just now. Try again."
                        }
                        savingName = false
                    }
                } label: {
                    if savingName {
                        ProgressView()
                    } else {
                        Text(address.customAddress == nil ? "Use this name" : "Change name")
                    }
                }.buttonStyle(SettingsActionStyle(filled: false))
                    .disabled(
                        savingName
                            || customName.trimmingCharacters(in: .whitespacesAndNewlines).count < 3)
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
                Button {
                    showPlus = true
                } label: {
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
}
