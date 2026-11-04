import SwiftUI

struct FiledEmailDetailView: View {
    let mail: FiledEmailSummary
    @Environment(AppStore.self) private var store
    @State private var original: OriginalEmail?
    @State private var loading = true
    @State private var loadError: String?
    @State private var actionNotice: String?
    @State private var actionError: String?
    @State private var busy = false
    @State private var confirmIgnore = false
    @State private var showConversation = false
    @State private var verification: OwnEmailAddress?
    private var current: FiledEmailSummary {
        store.filedEmailSummaries.first { $0.id == mail.id } ?? mail
    }
    private var marked: Bool { current.markedAsMe == true }
    private var ignored: Bool { store.ignoredSenderDomains.contains(mail.senderDomain) }
    var body: some View {
        SettingsPage(title: "Email") {
            HStack(spacing: 12) {
                SiteLogoTile(domain: mail.senderDomain, name: mail.senderDomain, size: 40)
                VStack(alignment: .leading, spacing: 5) {
                    Text(original?.from ?? current.senderAddress).font(
                        .subheadline.weight(.semibold)
                    ).textSelection(.enabled)
                    if let date = current.receivedAt {
                        Text(date.formatted(date: .abbreviated, time: .shortened)).font(.caption)
                            .foregroundStyle(HyggeTheme.secondary)
                    }
                }
            }
            Text(original?.subject ?? mail.subject).font(.title2.bold()).fixedSize(
                horizontal: false, vertical: true)
            if let original {
                if !original.to.isEmpty {
                    Text("To: \(original.to)").font(.caption).foregroundStyle(HyggeTheme.secondary)
                        .textSelection(.enabled)
                }
                if let cc = original.cc, !cc.isEmpty {
                    Text("Cc: \(cc)").font(.caption).foregroundStyle(HyggeTheme.secondary)
                        .textSelection(.enabled)
                }
                if original.truncated {
                    Label(
                        "This message exceeded the storage limit. Only the retained portion is shown.",
                        systemImage: "info.circle"
                    ).font(.footnote).foregroundStyle(HyggeTheme.secondary)
                }
            }
            if marked || current.relation == "owner" {
                Label(marked ? "Marked as you" : "From you", systemImage: "person.crop.circle")
                    .font(.subheadline).foregroundStyle(HyggeTheme.sageDeep)
            }
            if ignored {
                Label("Ignored · kept in your history", systemImage: "bell.slash").font(
                    .subheadline
                ).foregroundStyle(HyggeTheme.secondary)
            }
            if loading {
                ProgressView("Loading original email…")
            } else if let original {
                OriginalEmailBodyView(original: original)
                if !mail.attachments.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Attachments").font(.headline)
                        ForEach(mail.attachments, id: \.filename) { attachment in
                            Label(attachment.filename, systemImage: "paperclip").font(.subheadline)
                        }
                        Text("Attachment information only; files aren’t available here.").font(
                            .caption
                        ).foregroundStyle(HyggeTheme.secondary)
                    }
                }
            } else {
                if let loadError {
                    Label(loadError, systemImage: "wifi.slash").foregroundStyle(
                        HyggeTheme.secondary)
                    Button("Try again") { Task { await load() } }.foregroundStyle(
                        HyggeTheme.sageDeep)
                } else {
                    Label(
                        mail.kind == "other"
                            ? "The original wasn’t retained for this email. This is the saved summary."
                            : "Verification mail is handled separately. Only its summary is available here.",
                        systemImage: "info.circle"
                    )
                    .font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                }
                Text("Hygge summary").font(.caption.weight(.semibold)).foregroundStyle(
                    HyggeTheme.sageDeep)
                Text(mail.summary).textSelection(.enabled)
            }
            if let actionNotice {
                Label(actionNotice, systemImage: "info.circle").font(.subheadline).foregroundStyle(
                    HyggeTheme.secondary)
            }
            if let actionError {
                Label(actionError, systemImage: "exclamationmark.circle").font(.subheadline)
                    .foregroundStyle(HyggeTheme.emberDeep)
            }
        }
        .safeAreaInset(edge: .bottom) {
            Button("Discuss with Hygge") {
                store.pendingChatContext = ChatContextRef(
                    kind: "mail", id: mail.id, title: current.displayTitle,
                    subtitle: current.senderAddress, siteID: mail.siteID,
                    siteDomain: mail.senderDomain)
                showConversation = true
            }.buttonStyle(SettingsActionStyle()).padding(.horizontal, 22).padding(.vertical, 16)
                .background(HyggeTheme.paper)
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button(
                        marked ? "Remove “This is me” label" : "This is me",
                        systemImage: "person.crop.circle"
                    ) { markAsMe(!marked) }
                    if ignored {
                        Button("Stop ignoring this domain") { setIgnored(false) }
                    } else {
                        Button("Ignore mail from \(mail.senderDomain)") { confirmIgnore = true }
                    }
                    NavigationLink("Email preferences") { EmailPreferencesView() }
                } label: {
                    Image(systemName: "ellipsis").frame(width: 44, height: 44)
                }.accessibilityLabel("Email options").disabled(busy)
            }
        }
        .task(id: mail.id) { await load() }
        .alert("Ignore mail from \(mail.senderDomain)?", isPresented: $confirmIgnore) {
            Button("Ignore this domain", role: .destructive) { setIgnored(true) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "Mail from this entire domain will stay in history, but Hygge will stop checking it for work and showing journal entries or suggestions."
            )
        }
        .sheet(isPresented: $showConversation) {
            ConversationView().presentationDragIndicator(.visible)
        }
        .sheet(item: $verification) {
            EmailAddressVerificationView(address: $0).presentationDragIndicator(.visible)
        }
    }
    private func load() async {
        loading = true
        loadError = nil
        do { original = try await store.originalEmail(id: mail.id) } catch {
            loadError = "Couldn’t load the original email. Please try again."
        }
        loading = false
    }
    private func markAsMe(_ value: Bool) {
        guard !busy else { return }
        busy = true
        actionError = nil
        Task {
            do {
                let address = try await store.markEmailAsMe(id: mail.id, marked: value)
                if let address, !address.verified { verification = address }
                if value && address == nil {
                    actionNotice =
                        "Marked as you. This email’s sender address wasn’t retained; add your address in Email preferences."
                } else {
                    actionNotice = nil
                }
            } catch {
                actionError =
                    "Couldn’t update this email. For older messages, add your address in Email preferences."
            }
            busy = false
        }
    }
    private func setIgnored(_ value: Bool) {
        guard !busy else { return }
        busy = true
        actionError = nil
        Task {
            if !(await store.decideEmailSender(
                domain: mail.senderDomain, choice: value ? "ignore" : "work"))
            {
                actionError = "Couldn’t update this preference. Please try again."
            }
            busy = false
        }
    }
}
