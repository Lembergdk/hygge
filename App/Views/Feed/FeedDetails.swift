import SwiftUI

struct FeedProposalDetail: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let proposalID: UUID
    var body: some View {
        FeedSheet {
            if let proposal = store.proposals.first(where: { $0.id == proposalID }) {
                VStack(alignment: .leading, spacing: 10) {
                    Label(store.siteName(id: proposal.siteID), systemImage: "link")
                        .font(.system(.title, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink)
                    Text(proposal.rationale).foregroundStyle(HyggeTheme.secondary)
                }
                VStack(spacing: 18) {
                    FeedFact(icon: "banknote", title: "Pay", value: proposal.payPattern)
                    Divider().overlay(HyggeTheme.hairline)
                    FeedFact(icon: "person.crop.rectangle", title: "Shared", value: proposal.dataShared)
                    Divider().overlay(HyggeTheme.hairline)
                    FeedFact(icon: "checkmark.shield", title: "Checks", value: proposal.verification)
                }.padding(20).hyggeCard(radius: 22)
                if proposal.status == .proposed {
                    VStack(spacing: 12) {
                        FeedPrimaryButton(title: "Create my account") {
                            store.approveProposal(proposalID: proposalID, alreadyHasAccount: false); dismiss()
                        }
                        Button("I have one") {
                            store.approveProposal(proposalID: proposalID, alreadyHasAccount: true); dismiss()
                        }.foregroundStyle(HyggeTheme.ink).frame(maxWidth: .infinity, minHeight: 44)
                    }.padding(.top, 12)
                }
            } else { Text("This suggestion is no longer available.").foregroundStyle(HyggeTheme.secondary) }
        }
    }
}

struct FeedOpportunityDetail: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let opportunityID: UUID
    var body: some View {
        FeedSheet {
            if let opportunity = store.opportunities.first(where: { $0.id == opportunityID }) {
                Text(opportunity.title).font(.system(.title2, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink)
                Text(store.siteName(id: opportunity.siteID)).foregroundStyle(HyggeTheme.sageDeep)
                VStack(spacing: 18) {
                    FeedFact(icon: "banknote", title: "Pay", value: opportunity.payLabel)
                    FeedFact(icon: "mappin", title: "Location", value: opportunity.isRemote ? "Remote" : opportunity.locationLabel)
                }.padding(20).hyggeCard(radius: 22)
                Text(opportunity.summary).foregroundStyle(HyggeTheme.ink)
                if !opportunity.requiredSkills.isEmpty {
                    FeedFact(icon: "sparkles", title: "Skills", value: opportunity.requiredSkills.joined(separator: ", "))
                }
                if !store.applications.contains(where: { $0.opportunityID == opportunity.id }) {
                    FeedPrimaryButton(title: "Prepare an application") { store.draftApplication(for: opportunity); dismiss() }
                    Text("You’ll review it before anything is sent.").font(.caption).foregroundStyle(HyggeTheme.secondary)
                }
            } else { Text("This opportunity is no longer available.").foregroundStyle(HyggeTheme.secondary) }
        }
    }
}

struct FeedEventDetail: View {
    @Environment(AppStore.self) private var store
    let event: ActivityEvent
    @State private var money: ApplicationRecord?
    var body: some View {
        FeedSheet {
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
    @Environment(\.dismiss) private var dismiss
    let taskID: UUID
    @State private var submitting = false
    @State private var audit = false
    private var task: AgentTask? { store.tasks.first { $0.id == taskID } }
    private let visibleKeys = ["profileHeadline", "profileBio", "coverLetter", "message", "displayName", "hourlyRate", "skills", "eventTitle", "eventStartISO8601", "location", "searchTerms"]
    var body: some View {
        FeedSheet {
            if let task {
                Text(task.kind == .buildProfile ? "Review your profile" : task.title)
                    .font(.system(.title2, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink)
                Text(store.siteName(id: task.siteID)).foregroundStyle(HyggeTheme.sageDeep)
                if task.needsChatHelp {
                    Text(task.help?.message ?? "Hygge needs your help to continue.").foregroundStyle(HyggeTheme.ink)
                    FeedPrimaryButton(title: "Continue in chat") {
                        store.surfaceTaskHelp(taskID: task.id); store.conversationTaskID = task.id; dismiss()
                    }
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
                    if task.status == .awaitingApproval || task.status == .draft {
                        Text(effect(task)).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                        FeedPrimaryButton(title: submitting ? "Starting…" : actionTitle(task)) {
                            guard !submitting else { return }; submitting = true
                            Task { await store.approveAndRun(taskID: taskID) }
                            dismiss()
                        }.disabled(submitting || store.isPaused)
                        if store.isPaused { Text("Resume Hygge before continuing.").font(.caption).foregroundStyle(HyggeTheme.secondary) }
                    }
                }
                Button("Full details") { audit = true }.foregroundStyle(HyggeTheme.sageDeep).frame(minHeight: 44)
            } else { Text("This work is no longer available.").foregroundStyle(HyggeTheme.secondary) }
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
