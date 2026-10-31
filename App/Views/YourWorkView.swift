import SwiftUI

/// Everything in flight, grouped the way people actually ask about it:
/// Applied · Active · Done. Opened from the journal's "Your work".
struct YourWorkView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var moneyApplication: ApplicationRecord?
    @State private var completingApplication: ApplicationRecord?
    @State private var completionAmount = ""

    var body: some View {
        NavigationStack {
            ZStack {
                HyggeTheme.paper.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        if store.applications.isEmpty {
                            Text("Nothing in flight yet. When Hygge drafts and sends work for you, it lives here — the journal stays the calm version.")
                                .font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                                .padding(17).hyggeCard(radius: 20)
                        }
                        group("Applied", stages: [.drafted, .submitted])
                        group("Active", stages: [.interviewing, .booked])
                        group("Done", stages: [.completed, .rejected])
                        earningsCard
                    }
                    .padding(.horizontal, 18).padding(.top, 10)
                }
            }
            .navigationTitle("Your work")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }.foregroundStyle(HyggeTheme.ink)
                }
            }
            .sheet(item: $moneyApplication) { MoneyConfirmationView(application: $0) }
            .sheet(item: $completingApplication) { application in
                NavigationStack {
                    Form {
                        Section("How much did \(application.title) actually pay?") {
                            TextField("Amount", text: $completionAmount).keyboardType(.decimalPad)
                            Text("This is the only way work enters your earnings and journal totals.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Button("Mark complete") {
                            if let amount = Double(completionAmount) {
                                store.completeWork(applicationID: application.id, grossAmount: amount)
                                completingApplication = nil
                                moneyApplication = store.applications.first { $0.id == application.id }
                            }
                        }
                        .disabled(Double(completionAmount) == nil)
                    }
                    .navigationTitle("Complete work")
                }
            }
        }
    }

    @ViewBuilder
    private func group(_ title: String, stages: [ApplicationStage]) -> some View {
        let items = store.applications.filter { stages.contains($0.stage) }
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text(title).font(.system(.title3, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink)
                ForEach(items) { application in row(application) }
            }
        }
    }

    private func row(_ application: ApplicationRecord) -> some View {
        let opportunity = store.opportunities.first { $0.id == application.opportunityID }
        return VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(application.title).font(.subheadline.weight(.semibold)).foregroundStyle(HyggeTheme.ink)
                    Text("\(store.siteName(id: application.siteID)) • \(opportunity?.payLabel ?? "pay: see listing")")
                        .font(.caption).foregroundStyle(HyggeTheme.secondary)
                }
                Spacer()
                Text(application.stage.label)
                    .font(.caption2.weight(.bold)).foregroundStyle(HyggeTheme.sageDeep)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(HyggeTheme.sage.opacity(0.22), in: Capsule())
            }
            HStack(spacing: 12) {
                Menu("Move to…") {
                    ForEach(ApplicationStage.allCases.filter { $0 != .completed }, id: \.self) { stage in
                        Button(stage.label) { store.setApplicationStage(stage, applicationID: application.id) }
                    }
                    Button("Completed — enter amount paid…") { completingApplication = application }
                }
                .font(.caption.weight(.medium)).foregroundStyle(HyggeTheme.sageDeep)
                if application.stage == .completed {
                    Button("See the money") { moneyApplication = application }
                        .font(.caption.weight(.medium)).foregroundStyle(HyggeTheme.ember)
                }
            }
        }
        .padding(15).hyggeCard(radius: 18)
    }

    private var earningsCard: some View {
        let gross = store.earningsGross
        let parts = HyggeFee.breakdown(gross: gross)
        return VStack(alignment: .leading, spacing: 8) {
            Text("Earnings so far").font(.system(.headline, design: .rounded, weight: .semibold)).foregroundStyle(HyggeTheme.ink)
            moneyRow("Completed work (amounts you confirmed)", JournalBuilder.money(gross))
            if !HyggeFee.isFinalized {
                // Product truth (deck): subscription, no cut. Free until
                // $100 earned in a month, then Plus. Nothing is deducted.
                Text("All yours — Hygge takes no cut. It's free until you earn $100 in a month, then Plus keeps it unlimited.")
                    .font(.caption).foregroundStyle(HyggeTheme.secondary)
            } else {
                moneyRow("Hygge's \(HyggeFee.percentLabel)", "−" + JournalBuilder.money(parts.fee))
            }
            Text("Only work you confirm at completion counts here — estimates and asking prices never do.")
                .font(.caption).foregroundStyle(HyggeTheme.secondary)
        }
        .padding(17).hyggeCard(radius: 20)
    }

    private func moneyRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).font(.subheadline).foregroundStyle(HyggeTheme.ink)
            Spacer()
            Text(value).font(.subheadline).foregroundStyle(HyggeTheme.ink)
        }
    }
}

/// The money moment (spec §5.5): one thing, fee as its own line, warm not loud.
struct MoneyConfirmationView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    var application: ApplicationRecord

    var body: some View {
        let gross = application.agreedGross ?? 0
        let parts = HyggeFee.breakdown(gross: gross)
        ZStack {
            HyggeTheme.paper.ignoresSafeArea()
            VStack(spacing: 26) {
                Spacer()
                Text("Done.")
                    .font(.system(size: 44, weight: .bold, design: .rounded)).foregroundStyle(HyggeTheme.ink)
                VStack(alignment: .leading, spacing: 16) {
                    Text(application.title)
                        .font(.system(.title3, design: .rounded, weight: .semibold)).foregroundStyle(HyggeTheme.ink)
                    Divider().overlay(HyggeTheme.hairline)
                    row("Pay", JournalBuilder.money(gross, currencyCode: application.currencyCode))
                    if HyggeFee.isFinalized {
                        Divider().overlay(HyggeTheme.hairline)
                        row("Hygge's cut \(HyggeFee.percentLabel)", "−" + JournalBuilder.money(parts.fee, currencyCode: application.currencyCode))
                    }
                    Divider().overlay(HyggeTheme.hairline)
                    HStack {
                        Text("You keep").font(.system(.title3, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink)
                        Spacer()
                        Text(JournalBuilder.money(HyggeFee.isFinalized ? parts.net : gross, currencyCode: application.currencyCode))
                            .font(.system(.title2, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.sageDeep)
                    }
                    if !HyggeFee.isFinalized {
                        Text("All yours — Hygge's pricing isn't final yet, and nothing was deducted.")
                            .font(.caption).foregroundStyle(HyggeTheme.secondary)
                    }
                }
                .padding(22).hyggeCard(radius: 26)
                Spacer()
                Button("Continue") { dismiss() }
                    .font(.headline).frame(maxWidth: .infinity).padding(.vertical, 17)
                    .background(HyggeTheme.sage, in: Capsule()).foregroundStyle(.white)
            }
            .padding(.horizontal, 22).padding(.bottom, 18)
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).font(.system(.title3, design: .rounded)).foregroundStyle(HyggeTheme.ink)
            Spacer()
            Text(value).font(.system(.title3, design: .rounded)).foregroundStyle(HyggeTheme.ink)
        }
    }
}
