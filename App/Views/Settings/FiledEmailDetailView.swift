import SwiftUI

/// Cards, history and notification taps open the AI summary first.
/// Only Email details navigates to and fetches the original message.
struct FiledEmailDetailView: View {
    let mail: FiledEmailSummary
    var isFeedCard = false
    /// When set (feed card detail), discussing opens the caller's chat
    /// surface instead of this view's own sheet.
    var discussInChat: ((ChatContextRef) -> Void)? = nil
    @State private var showOriginal = false
    @Environment(AppStore.self) private var store
    private var current: FiledEmailSummary {
        store.filedEmailSummaries.first { $0.id == mail.id } ?? mail
    }
    var body: some View {
        Group {
            if isFeedCard && showOriginal {
                OriginalEmailDetailView(mail: current, isFeedCard: true, backToSummary: { showOriginal = false }, discussInChat: discussInChat)
            } else {
                summaryPage
            }
        }
        .foregroundStyle(HyggeTheme.ink)
        .tint(HyggeTheme.sageDeep)
        .fontDesign(.rounded)
    }
    private var summaryPage: some View {
        Group {
            if isFeedCard { summaryContent }
            else { SettingsPage(title: "Email summary") { summaryContent } }
        }
        .modifier(EmailMessageActions(mail: mail, isFeedCard: isFeedCard, discussInChat: discussInChat))
    }
    @ViewBuilder private var summaryContent: some View {
            HStack(spacing: 12) {
                SiteLogoTile(domain: mail.senderDomain, name: mail.senderDomain, size: 40)
                VStack(alignment: .leading, spacing: 5) {
                    Text(current.senderAddress).font(.subheadline.weight(.semibold)).textSelection(
                        .enabled)
                    if let date = current.receivedAt {
                        Text(date.formatted(date: .abbreviated, time: .shortened)).font(.caption)
                            .foregroundStyle(HyggeTheme.secondary)
                    }
                }
            }
            Text(current.displayTitle).font(.title2.bold()).fixedSize(
                horizontal: false, vertical: true)
                .feedCardDismissRegion()
            if current.markedAsMe == true || current.relation == "owner" {
                Label(
                    current.markedAsMe == true ? "Marked as you" : "From you",
                    systemImage: "person.crop.circle"
                )
                .font(.subheadline).foregroundStyle(HyggeTheme.sageDeep)
            }
            if store.ignoredSenderDomains.contains(mail.senderDomain) {
                Label("Ignored · kept in your history", systemImage: "bell.slash").font(
                    .subheadline
                ).foregroundStyle(HyggeTheme.secondary)
            }
            VStack(alignment: .leading, spacing: 8) {
                Label("Hygge summary", systemImage: "sparkles").font(.caption.weight(.semibold))
                    .foregroundStyle(HyggeTheme.sageDeep)
                Text(current.summary).textSelection(.enabled).fixedSize(
                    horizontal: false, vertical: true)
            }
            if let jobs = current.jobs, !jobs.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Roles mentioned in this email").font(.subheadline.weight(.semibold))
                    ForEach(jobs, id: \.self) { job in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(job.title).font(.subheadline.weight(.semibold))
                            if !job.detail.isEmpty {
                                Text(job.detail).font(.caption).foregroundStyle(
                                    HyggeTheme.secondary)
                            }
                        }
                        if job != jobs.last { Divider() }
                    }
                }
            }
            if isFeedCard {
                Button { showOriginal = true } label: { originalEmailLink }
                    .buttonStyle(.plain)
            } else {
                NavigationLink { OriginalEmailDetailView(mail: current) } label: { originalEmailLink }
                    .buttonStyle(.plain)
            }
    }
    private var originalEmailLink: some View {
        SettingsRow(title: "Email details", icon: "envelope.open", subtitle: "Read the original email")
    }
}

struct OriginalEmailDetailView: View {
    let mail: FiledEmailSummary
    var isFeedCard = false
    var backToSummary: (() -> Void)?
    var discussInChat: ((ChatContextRef) -> Void)? = nil
    @Environment(AppStore.self) private var store
    @State private var original: OriginalEmail?
    @State private var loading = true
    @State private var loadError: String?
    private var current: FiledEmailSummary {
        store.filedEmailSummaries.first { $0.id == mail.id } ?? mail
    }
    var body: some View {
        Group {
            if isFeedCard { originalContent }
            else { SettingsPage(title: "Email details") { originalContent } }
        }
        .task(id: mail.id) { await load() }
        .modifier(EmailMessageActions(mail: mail, isFeedCard: isFeedCard,
                                      pageTitle: "Email details", backToSummary: backToSummary, discussInChat: discussInChat))
    }
    @ViewBuilder private var originalContent: some View {
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
                .feedCardDismissRegion()
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
            if current.markedAsMe == true || current.relation == "owner" {
                Label(
                    current.markedAsMe == true ? "Marked as you" : "From you",
                    systemImage: "person.crop.circle"
                )
                .font(.subheadline).foregroundStyle(HyggeTheme.sageDeep)
            }
            if store.ignoredSenderDomains.contains(mail.senderDomain) {
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
    }
    private func load() async {
        loading = true
        loadError = nil
        original = nil
        do {
            let fetched = try await store.originalEmail(id: mail.id)
            guard !Task.isCancelled else { return }
            original = fetched
        } catch {
            guard !Task.isCancelled else { return }
            loadError = "Couldn’t load the original email. Please try again."
        }
        loading = false
    }

}

private struct EmailMessageActions: ViewModifier {
    let mail: FiledEmailSummary
    var isFeedCard = false
    var pageTitle = "Email summary"
    var backToSummary: (() -> Void)?
    /// When set (feed card detail), discussing opens the caller's chat
    /// surface instead of this view's own sheet.
    var discussInChat: ((ChatContextRef) -> Void)? = nil
    @Environment(AppStore.self) private var store
    @State private var actionNotice: String?
    @State private var actionError: String?
    @State private var busy = false
    @State private var confirmIgnore = false
    @State private var showPreferences = false
    @State private var showConversation = false
    @State private var verification: OwnEmailAddress?
    private var current: FiledEmailSummary {
        store.filedEmailSummaries.first { $0.id == mail.id } ?? mail
    }
    private var marked: Bool { current.markedAsMe == true }
    private var ignored: Bool { store.ignoredSenderDomains.contains(mail.senderDomain) }
    func body(content: Content) -> some View {
        page(content: content)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    if !isFeedCard { optionsMenu }
                }
            }
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
            .sheet(isPresented: $showPreferences) {
                NavigationStack { EmailPreferencesView() }.presentationDragIndicator(.visible)
            }
    }
    @ViewBuilder private func page(content: Content) -> some View {
        if isFeedCard {
            FeedDetailContent {
                HStack {
                    if let backToSummary {
                        Button(action: backToSummary) { Label("Email summary", systemImage: "chevron.left") }
                            .font(.subheadline.weight(.semibold)).foregroundStyle(HyggeTheme.sageDeep)
                            .frame(minHeight: 44)
                    } else {
                        Text(pageTitle).font(.caption.weight(.semibold)).foregroundStyle(HyggeTheme.secondary)
                    }
                    Spacer()
                    optionsMenu
                }
                content
            } footer: { actionControls }
        } else {
            content.safeAreaInset(edge: .bottom) {
                actionControls.padding(.horizontal, 22).padding(.vertical, 16).background(HyggeTheme.paper)
            }
        }
    }
    private var actionControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let actionNotice {
                Label(actionNotice, systemImage: "info.circle").font(.footnote)
                    .foregroundStyle(HyggeTheme.secondary)
            }
            if let actionError {
                Label(actionError, systemImage: "exclamationmark.circle").font(.footnote)
                    .foregroundStyle(HyggeTheme.emberDeep)
            }
            Button("Discuss in chat") {
                let context = ChatContextRef(
                    kind: "mail", id: mail.id, title: current.displayTitle,
                    subtitle: current.senderAddress, siteID: mail.siteID,
                    siteDomain: mail.senderDomain)
                if let discussInChat { discussInChat(context) } else {
                    store.pendingChatContext = context
                    showConversation = true
                }
            }.buttonStyle(SettingsActionStyle())
        }
    }
    private var optionsMenu: some View {
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
                        if isFeedCard {
                            Button("Email preferences") { showPreferences = true }
                        } else {
                            NavigationLink("Email preferences") { EmailPreferencesView() }
                        }
                    } label: {
                        Image(systemName: "ellipsis").frame(width: 44, height: 44)
                    }.accessibilityLabel("Email options").disabled(busy)
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
