import SwiftUI

struct FeedProposalDetail: View {
    @Environment(AppStore.self) private var store
    let close: () -> Void
    let proposalID: UUID
    private var proposal: ProposedSite? { store.proposals.first(where: { $0.id == proposalID }) }
    var body: some View {
        FeedDetailContent {
            if let proposal {
                VStack(alignment: .leading, spacing: 10) {
                    // Long unbroken site names ("TrustedHousesitters")
                    // hyphen-break in an icon+title row at large type:
                    // beside when it fits, icon above when it doesn't.
                    ViewThatFits(in: .horizontal) {
                        Label(store.siteName(id: proposal.siteID), systemImage: "link")
                        VStack(alignment: .leading, spacing: 10) {
                            Image(systemName: "link").foregroundStyle(HyggeTheme.sageDeep)
                            Text(store.siteName(id: proposal.siteID))
                        }
                    }
                    .font(.system(.title2, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink)
                    Text(proposal.rationale).foregroundStyle(HyggeTheme.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                VStack(spacing: 18) {
                    FeedFact(icon: "banknote", title: "Pay", value: proposal.payPattern)
                    Divider().overlay(HyggeTheme.hairline)
                    FeedFact(icon: "person.crop.rectangle", title: "Shared", value: proposal.dataShared)
                    Divider().overlay(HyggeTheme.hairline)
                    FeedFact(icon: "checkmark.shield", title: "Checks", value: proposal.verification)
                }.padding(20).hyggeCard(radius: 22)
            } else { Text("This suggestion is no longer available.").foregroundStyle(HyggeTheme.secondary) }
        } footer: {
            if let proposal, proposal.status == .proposed {
                FeedPrimaryButton(title: "Create my account") {
                    store.approveProposal(proposalID: proposalID, alreadyHasAccount: false); close()
                }
                Button("I have one") {
                    store.approveProposal(proposalID: proposalID, alreadyHasAccount: true); close()
                }.foregroundStyle(HyggeTheme.ink).frame(maxWidth: .infinity, minHeight: 44)
            }
        }
    }
}

struct FeedOpportunityDetail: View {
    @Environment(AppStore.self) private var store
    let close: () -> Void
    let opportunityID: UUID
    @State private var saveLogin = false
    @State private var openSite = false
    private var opportunity: Opportunity? { store.opportunities.first(where: { $0.id == opportunityID }) }
    var body: some View {
        FeedDetailContent {
            if let opportunity {
                VStack(alignment: .leading, spacing: 4) {
                    Text(opportunity.title).font(.system(.title2, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(store.siteName(id: opportunity.siteID)).font(.subheadline.weight(.medium)).foregroundStyle(HyggeTheme.sageDeep)
                }
                if opportunity.needsYouKind != nil {
                    // A blocked look, not work: the one action is the fix (footer).
                    Text(opportunity.summary).foregroundStyle(HyggeTheme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    // All facts in the one inset container, summary
                    // included, so nothing renders in a second style.
                    VStack(spacing: 18) {
                        FeedFact(icon: "banknote", title: "Pay", value: opportunity.payLabel)
                        Divider().overlay(HyggeTheme.hairline)
                        FeedFact(icon: "mappin", title: "Location", value: opportunity.isRemote ? "Remote" : opportunity.locationLabel)
                        if !opportunity.requiredSkills.isEmpty {
                            Divider().overlay(HyggeTheme.hairline)
                            FeedFact(icon: "sparkles", title: "Skills", value: opportunity.requiredSkills.joined(separator: ", "))
                        }
                    }.padding(20).hyggeCard(radius: 22)
                    Text(opportunity.summary).foregroundStyle(HyggeTheme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else { Text("This opportunity is no longer available.").foregroundStyle(HyggeTheme.secondary) }
        } footer: {
            if let opportunity {
                if let blockedKind = opportunity.needsYouKind {
                    if blockedKind == "login" {
                        FeedPrimaryButton(title: "Save login again") { saveLogin = true }
                    } else {
                        FeedPrimaryButton(title: "Open \(store.siteName(id: opportunity.siteID))") { openSite = true }
                    }
                } else if !store.applications.contains(where: { $0.opportunityID == opportunity.id }) {
                    FeedPrimaryButton(title: "Prepare an application") { store.draftApplication(for: opportunity); close() }
                    Text("You’ll review it before anything is sent.").font(.caption).foregroundStyle(HyggeTheme.secondary)
                        .frame(maxWidth: .infinity, alignment: .center).padding(.top, 6)
                }
            }
        }
        .sheet(isPresented: $saveLogin) {
            if let opportunity = store.opportunities.first(where: { $0.id == opportunityID }) {
                CredentialSaveSheet(siteName: store.siteName(id: opportunity.siteID),
                                    domain: store.site(id: opportunity.siteID)?.domain ?? opportunity.urlString) { saved in
                    // A saved login ends the episode (the backend clears
                    // it); drop the card here so the feed agrees at once.
                    if saved { store.setStatus(.dismissed, for: opportunity.id); close() }
                }.presentationDragIndicator(.visible)
            }
        }
        .sheet(isPresented: $openSite) {
            if let opportunity = store.opportunities.first(where: { $0.id == opportunityID }) {
                CloudBrowserView(urlString: opportunity.urlString, takeControlOnOpen: true)
            }
        }
    }
}

struct FeedEventDetail: View {
    @Environment(AppStore.self) private var store
    let event: ActivityEvent
    @State private var money: ApplicationRecord?
    var body: some View {
        FeedDetailContent {
            if event.kind == .workCompleted {
                Image("SettingsEarnings").resizable().scaledToFit().frame(height: 120).frame(maxWidth: .infinity)
            }
            Text(FeedEventPresentation.title(event)).font(.system(.title, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink)
            Text(event.occurredAt.formatted(date: .abbreviated, time: .shortened)).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
            Text(event.sentence).foregroundStyle(HyggeTheme.ink)
            if !event.detail.isEmpty {
                FeedFact(icon: "text.alignleft", title: "The details", value: event.detail).padding(20).hyggeCard(radius: 22)
            }
            if let id = event.applicationID, let application = store.applications.first(where: { $0.id == id }), application.stage == .completed {
                FeedPrimaryButton(title: "See the breakdown") { money = application }
            }
        }.sheet(item: $money) { MoneyConfirmationView(application: $0) }
    }
}

/// The feed never approves a public action from a swipe. Its primary action
/// opens this review, with the actual draft and the existing approval gate.
struct FeedTaskReview: View {
    @Environment(AppStore.self) private var store
    let close: () -> Void
    let taskID: UUID
    @State private var submitting = false
    @State private var audit = false
    private var task: AgentTask? { store.tasks.first { $0.id == taskID } }
    private let visibleKeys = ["profileHeadline", "profileBio", "coverLetter", "message", "displayName", "hourlyRate", "skills", "eventTitle", "eventStartISO8601", "location", "searchTerms"]
    var body: some View {
        FeedDetailContent {
            if let task {
                VStack(alignment: .leading, spacing: 4) {
                    Text(task.kind == .buildProfile ? "Review your profile" : task.title)
                        .font(.system(.title2, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(store.siteName(id: task.siteID)).font(.subheadline.weight(.medium)).foregroundStyle(HyggeTheme.sageDeep)
                }
                if task.needsChatHelp {
                    Text(task.help?.message ?? "Hygge needs your help to continue.").foregroundStyle(HyggeTheme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    ForEach(visibleKeys.filter { task.draftedPayload[$0]?.isEmpty == false }, id: \.self) { key in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(label(key)).font(.subheadline.weight(.semibold)).foregroundStyle(HyggeTheme.secondary)
                            if task.status == .awaitingApproval || task.status == .draft {
                                TextField(label(key), text: Binding(get: {
                                    store.tasks.first { $0.id == taskID }?.draftedPayload[key] ?? ""
                                }, set: { store.updatePayload(taskID: taskID, key: key, value: $0) }), axis: .vertical)
                                    .foregroundStyle(HyggeTheme.ink).lineLimit(2...12)
                            } else { Text(task.draftedPayload[key] ?? "").foregroundStyle(HyggeTheme.ink) }
                        }.padding(18).hyggeCard(radius: 18)
                    }
                }
                Button("Full details") { audit = true }.foregroundStyle(HyggeTheme.sageDeep).frame(minHeight: 44)
            } else { Text("This work is no longer available.").foregroundStyle(HyggeTheme.secondary) }
        } footer: {
            // The approve action is the point of this surface: pinned,
            // never below the fold behind the field cards.
            if let task {
                if task.needsChatHelp {
                    FeedPrimaryButton(title: "Continue in chat") {
                        store.surfaceTaskHelp(taskID: task.id); store.conversationTaskID = task.id; close()
                    }
                } else if task.status == .awaitingApproval || task.status == .draft {
                    Text(effect(task)).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                        .fixedSize(horizontal: false, vertical: true).padding(.bottom, 8)
                    FeedPrimaryButton(title: submitting ? "Starting…" : actionTitle(task)) {
                        guard !submitting else { return }; submitting = true
                        Task { await store.approveAndRun(taskID: taskID) }
                        close()
                    }.disabled(submitting || store.isPaused)
                    if store.isPaused {
                        Text("Resume Hygge before continuing.").font(.caption).foregroundStyle(HyggeTheme.secondary)
                            .frame(maxWidth: .infinity, alignment: .center).padding(.top, 6)
                    }
                }
            }
        }.sheet(isPresented: $audit) { NavigationStack { TaskDetailView(taskID: taskID) } }
    }
    private func label(_ key: String) -> String {
        switch key {
        case "profileHeadline": return "Headline"
        case "profileBio": return "Profile text"
        case "coverLetter", "message": return "Your message"
        case "displayName": return "Name"
        case "hourlyRate": return "Hourly rate"
        case "skills": return "Skills"
        case "eventTitle": return "Event"
        case "eventStartISO8601": return "When"
        case "location": return "Location"
        default: return "Search terms"
        }
    }
    private func actionTitle(_ task: AgentTask) -> String {
        switch task.kind {
        case .buildProfile: return "Publish profile"
        case .apply: return "Send application"
        case .message: return "Send message"
        case .bookCalendar: return "Add to calendar"
        case .signup: return "Start setup"
        case .discover: return "Find work"
        }
    }
    private func effect(_ task: AgentTask) -> String {
        switch task.kind {
        case .buildProfile: return "Your approved profile may become visible to people on \(store.siteName(id: task.siteID))."
        case .apply, .message: return "This sends your approved message on \(store.siteName(id: task.siteID))."
        case .bookCalendar: return "This adds the event to your calendar."
        case .signup: return "Hygge will set up your account and ask if it needs your help."
        case .discover: return "Hygge will look for work that fits your preferences."
        }
    }
}
