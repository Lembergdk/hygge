import SwiftUI

struct ContentView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        if !store.hasOnboarded {
            OnboardingView()
        } else {
            TabView {
                OpportunityFeedView()
                    .tabItem { Label("Opportunities", systemImage: "sparkle.magnifyingglass") }
                ApprovalsView()
                    .tabItem { Label("Approvals", systemImage: "checkmark.shield") }
                    .badge(store.pendingApprovalCount)
                ApplicationsView()
                    .tabItem { Label("Applications", systemImage: "tray.full") }
                SitesView()
                    .tabItem { Label("Sites", systemImage: "square.grid.2x2") }
                MemoryView()
                    .tabItem { Label("Memory", systemImage: "brain") }
                ProfileView()
                    .tabItem { Label("Profile", systemImage: "person.crop.circle") }
            }
        }
    }
}

struct OpportunityFeedView: View {
    @Environment(AppStore.self) private var store
    @State private var categoryFilter: OpportunityCategory?

    var body: some View {
        NavigationStack {
            List {
                if let message = store.lastMessage {
                    Text(message).font(.footnote).foregroundStyle(.secondary)
                }
                Picker("Category", selection: $categoryFilter) {
                    Text("All").tag(Optional<OpportunityCategory>.none)
                    ForEach(OpportunityCategory.allCases) { category in
                        Text(category.label).tag(Optional(category))
                    }
                }
                ForEach(filtered, id: \.0.id) { opportunity, match in
                    NavigationLink {
                        OpportunityDetailView(opportunity: opportunity, match: match)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(opportunity.title).font(.headline)
                                Spacer()
                                Text("\(match.percent)%").font(.headline).foregroundStyle(.green)
                            }
                            Text("\(store.siteName(id: opportunity.siteID)) • \(opportunity.payLabel) • \(opportunity.isRemote ? "Remote" : opportunity.locationLabel)")
                                .font(.subheadline).foregroundStyle(.secondary)
                            if opportunity.isDemo {
                                Text("DEMO listing — live ones come from cloud-browser searches")
                                    .font(.caption2).foregroundStyle(.orange)
                            }
                        }
                    }
                    .swipeActions(edge: .leading) {
                        Button("Save") { store.setStatus(.saved, for: opportunity.id) }.tint(.blue)
                    }
                    .swipeActions(edge: .trailing) {
                        Button("Dismiss", role: .destructive) { store.setStatus(.dismissed, for: opportunity.id) }
                    }
                }
            }
            .navigationTitle("Opportunities")
        }
    }

    private var filtered: [(Opportunity, MatchResult)] {
        store.rankedOpportunities.filter { categoryFilter == nil || $0.0.category == categoryFilter }
    }

}

struct OpportunityDetailView: View {
    @Environment(AppStore.self) private var store
    let opportunity: Opportunity
    let match: MatchResult
    @State private var showBrowser = false
    @State private var bookingDate = Date().addingTimeInterval(24 * 3600)

    var body: some View {
        Form {
            Section {
                Text(opportunity.summary)
                Text("\(opportunity.payLabel) • \(opportunity.isRemote ? "Remote" : opportunity.locationLabel)")
                    .foregroundStyle(.secondary)
                if opportunity.isDemo {
                    Label("Demo listing shipped with v1", systemImage: "testtube.2").foregroundStyle(.orange)
                }
            }
            Section("Why this matches you (\(match.percent)%)") {
                ForEach(match.reasons, id: \.self) { reason in Text(reason) }
            }
            Section("Next steps — the browser agent drafts, you approve") {
                Button("Draft a browser application task") { store.draftApplication(for: opportunity) }
                DatePicker("Proposed booking time", selection: $bookingDate)
                Button("Draft a calendar booking") { store.draftBookCalendar(for: opportunity, when: bookingDate) }
                Button("Open in cloud browser") { showBrowser = true }
            }
        }
        .navigationTitle(opportunity.title)
        .sheet(isPresented: $showBrowser) {
            NavigationStack {
                CloudBrowserView(urlString: opportunity.urlString)
                    .navigationTitle("Cloud browser")
            }
        }
    }
}
