import SwiftUI

/// The money moment (spec §5.5): one thing, fee as its own line, warm not loud.
/// Read-only receipt for already-completed work, opened from a feed
/// event's detail ("See the breakdown").
struct MoneyConfirmationView: View {
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
