import SwiftUI

/// Pricing, as decided: Free covers the first $100 of logged
/// earnings each calendar month and up to 10 managed job sites.
/// At $100, Hygge stops working on NEW opportunities until the
/// 1st; work already under way carries on. Plus is $9.99/month,
/// unlimited, and lets the user name their Hygge email address.
/// Nothing is ever taken from the user's pay, and pricing is
/// promoted only here in Profile — never at signup. The numbers
/// come from `PlanSnapshot` (HyggeCore), the same reading the
/// work gates use.
struct PlanUsageState: Equatable {
    enum Tier: Equatable { case free, plus }
    var tier: Tier
    var earnedThisMonth: Double
    var managedSites: Int
    var monthName = "November"
    var restartLabel = "December 1"
    var renewsLabel: String?

    static let freeEarningsLimit = 100.0
    static let freeSiteLimit = 10

    var atLimit: Bool { tier == .free && earnedThisMonth >= Self.freeEarningsLimit }
    var earningsFraction: Double { min(earnedThisMonth / Self.freeEarningsLimit, 1) }
    var sitesFraction: Double { min(Double(managedSites) / Double(Self.freeSiteLimit), 1) }

    static let freeMid = PlanUsageState(tier: .free, earnedThisMonth: 42, managedSites: 4)
    static let freeNear = PlanUsageState(tier: .free, earnedThisMonth: 86, managedSites: 9)
    static let freeLimit = PlanUsageState(tier: .free, earnedThisMonth: 112, managedSites: 7)
    static let plus = PlanUsageState(tier: .plus, earnedThisMonth: 340, managedSites: 14,
                                     renewsLabel: "Renews December 3")
}

extension PlanUsageState {
    /// The live card: this month's witnessed accounting.
    init(_ snapshot: PlanSnapshot, renewsAt: Date?) {
        self.init(tier: snapshot.tier == .plus ? .plus : .free,
                  earnedThisMonth: snapshot.monthlyEarnings,
                  managedSites: snapshot.managedSites,
                  monthName: Date().formatted(.dateTime.month(.wide)),
                  restartLabel: snapshot.restartsAt.formatted(.dateTime.month(.wide).day()),
                  renewsLabel: renewsAt.map { "Renews \($0.formatted(.dateTime.month(.wide).day()))" })
    }
}

/// The plan card in Profile: where this month stands, and the one
/// door to Plus. Factual first, promotional second.
struct PlanCardView: View {
    let state: PlanUsageState
    var onSeePlus: () -> Void = {}
    var onManage: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(state.tier == .free ? "Free plan" : "Hygge Plus")
                    .font(.system(.title3, design: .rounded, weight: .bold))
                    .foregroundStyle(HyggeTheme.ink)
                Spacer(minLength: 8)
                if state.tier == .plus, let renews = state.renewsLabel {
                    Text(renews).font(.caption).foregroundStyle(HyggeTheme.secondary)
                }
            }
            if state.tier == .free {
                usageRow("Earnings in \(state.monthName)",
                         value: "\(money(state.earnedThisMonth)) of $100",
                         fraction: state.earningsFraction,
                         full: state.atLimit)
                usageRow("Job sites Hygge watches",
                         value: "\(state.managedSites) of \(PlanUsageState.freeSiteLimit)",
                         fraction: state.sitesFraction, full: false)
                if state.atLimit {
                    Text("You've passed the free $100 this month, so new searches pause until \(state.restartLabel). Work already under way carries on.")
                        .font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Keep going with Plus", action: onSeePlus)
                        .buttonStyle(SettingsActionStyle())
                } else {
                    Text("Free covers your first $100 of earnings each month. Nothing is ever taken from your pay.")
                        .font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    // Under the limit the door to Plus stays quiet;
                    // the strong button is earned at the limit.
                    Button(action: onSeePlus) {
                        HStack(spacing: 6) {
                            Text("See Hygge Plus").font(.subheadline.weight(.semibold))
                            Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                            Spacer(minLength: 0)
                        }
                        .foregroundStyle(HyggeTheme.sageDeep)
                        .frame(minHeight: 44).contentShape(Rectangle())
                    }
                }
            } else {
                usageFact("Earnings in \(state.monthName)", value: money(state.earnedThisMonth))
                usageFact("Job sites Hygge watches", value: "\(state.managedSites)")
                Text("Unlimited searches and job sites. Plus is a flat subscription — never a cut of your pay.")
                    .font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Manage subscription", action: onManage)
                    .buttonStyle(SettingsActionStyle(filled: false))
            }
        }
        .padding(18)
        .background(HyggeTheme.card, in: RoundedRectangle(cornerRadius: 22))
        .overlay(RoundedRectangle(cornerRadius: 22).stroke(HyggeTheme.hairline, lineWidth: 1))
        .accessibilityElement(children: .contain)
    }

    private func usageRow(_ label: String, value: String, fraction: Double, full: Bool) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                Text(label).font(.subheadline).foregroundStyle(HyggeTheme.ink)
                Spacer(minLength: 8)
                Text(value).font(.subheadline.weight(.semibold)).foregroundStyle(HyggeTheme.ink)
                    .monospacedDigit()
            }
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(HyggeTheme.paperDeep)
                    Capsule().fill(full ? HyggeTheme.ember : HyggeTheme.sage)
                        .frame(width: max(8, proxy.size.width * fraction))
                }
            }
            .frame(height: 8)
        }
        .accessibilityElement(children: .combine)
    }

    private func usageFact(_ label: String, value: String) -> some View {
        HStack(spacing: 8) {
            Text(label).font(.subheadline).foregroundStyle(HyggeTheme.ink)
            Spacer(minLength: 8)
            Text(value).font(.subheadline.weight(.semibold)).foregroundStyle(HyggeTheme.ink)
                .monospacedDigit()
        }
        .accessibilityElement(children: .combine)
    }

    private func money(_ amount: Double) -> String {
        amount.formatted(.currency(code: "USD").precision(.fractionLength(0)))
    }
}

/// The Plus sheet: quiet, factual, one action. Money stays calm —
/// no flame, no celebration (design rule). The price shown is the
/// store's; purchasing and restoring are the real flows.
struct PlusSheetView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var restoring = false
    @State private var restoreFoundNothing = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Hygge Plus")
                        .font(.system(.largeTitle, design: .rounded, weight: .bold))
                        .foregroundStyle(HyggeTheme.ink)
                    Text("For months when the work keeps coming.")
                        .font(.body).foregroundStyle(HyggeTheme.secondary)
                }
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(store.plusStore.priceDisplay)
                        .font(.system(.largeTitle, design: .rounded, weight: .bold))
                        .foregroundStyle(HyggeTheme.ink).monospacedDigit()
                    Text("/month").font(.body).foregroundStyle(HyggeTheme.secondary)
                }
                VStack(alignment: .leading, spacing: 16) {
                    benefit("magnifyingglass", title: "Searches never pause",
                            detail: "Free rests at $100 of earnings each month. Plus keeps looking.")
                    benefit("link", title: "As many job sites as you like",
                            detail: "Free watches 10 job sites. Plus has no limit.")
                    benefit("envelope", title: "Your name on your Hygge email",
                            detail: "Choose your own address, like sam@usehygge.cc.")
                    benefit("banknote", title: "Your pay stays yours",
                            detail: "A flat subscription, never a cut of what you earn.")
                }
                VStack(spacing: 12) {
                    Button {
                        Task { if await store.plusStore.purchase() { dismiss() } }
                    } label: {
                        if store.plusStore.purchaseInFlight { ProgressView() }
                        else { Text("Start Plus — \(store.plusStore.priceDisplay)/month") }
                    }
                    .buttonStyle(SettingsActionStyle())
                    .disabled(store.plusStore.purchaseInFlight || store.plusStore.isPlus)
                    Button {
                        restoring = true; restoreFoundNothing = false
                        Task {
                            if await store.plusStore.restore() { dismiss() }
                            else { restoreFoundNothing = true }
                            restoring = false
                        }
                    } label: {
                        if restoring { ProgressView() } else { Text("Restore purchase") }
                    }
                    .font(.subheadline.weight(.medium)).foregroundStyle(HyggeTheme.sageDeep)
                    .frame(minHeight: 44)
                    .disabled(restoring || store.plusStore.purchaseInFlight)
                    if store.plusStore.purchasePending {
                        Text("Your purchase is waiting for approval. Plus turns on as soon as it's approved.")
                            .font(.caption).foregroundStyle(HyggeTheme.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    } else if store.plusStore.lastPurchaseFailed {
                        Text("That didn't go through. Plus might not be available right now — please try again later.")
                            .font(.caption).foregroundStyle(HyggeTheme.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    } else if restoreFoundNothing {
                        Text("No earlier purchase found on this account.")
                            .font(.caption).foregroundStyle(HyggeTheme.secondary)
                    }
                }
                Text("Free stays free: your first $100 of earnings and 10 job sites, every month. Plus auto-renews monthly until cancelled. Cancel anytime in Settings.")
                    .font(.caption).foregroundStyle(HyggeTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 24).padding(.top, 30).padding(.bottom, 28)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(HyggeTheme.paper)
        .fontDesign(.rounded).tint(HyggeTheme.sageDeep)
        .buttonStyle(.plain)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { dismiss() } label: {
                    Image(systemName: "xmark").font(.subheadline.weight(.semibold))
                }.accessibilityLabel("Close")
            }
        }
    }

    private func benefit(_ icon: String, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon).font(.body.weight(.semibold))
                .foregroundStyle(HyggeTheme.sageDeep)
                .frame(width: 40, height: 40)
                .background(HyggeTheme.sageTint, in: RoundedRectangle(cornerRadius: 13))
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.body.weight(.semibold)).foregroundStyle(HyggeTheme.ink)
                Text(detail).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Home at the free limit: one quiet card where the paused card
/// sits, same posture — resting, not broken.
struct PlanLimitCardView: View {
    let state: PlanUsageState
    var onSeePlus: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Image(systemName: "moon.zzz").font(.body.weight(.semibold))
                    .foregroundStyle(HyggeTheme.sageDeep)
                Text("Resting until \(state.restartLabel)")
                    .font(.system(.title3, design: .rounded, weight: .bold))
                    .foregroundStyle(HyggeTheme.ink)
            }
            Text("You've earned $\(Int(state.earnedThisMonth)) in \(state.monthName) — past the free $100, so new searches pause. Work already under way carries on, and searching starts again on \(state.restartLabel).")
                .font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Keep going with Plus", action: onSeePlus)
                .buttonStyle(SettingsActionStyle())
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HyggeTheme.card, in: RoundedRectangle(cornerRadius: 22))
        .overlay(RoundedRectangle(cornerRadius: 22).stroke(HyggeTheme.hairline, lineWidth: 1))
        .shadow(color: Color.black.opacity(0.10), radius: 16, y: 6)
    }
}

#if DEBUG
/// Pricing design review (no scheme logic): launch with
/// --settings-preview --plan-preview and choose a screen via the
/// `planPreviewScreen` default (profile-free, profile-limit,
/// profile-plus, plus-sheet, feed-limit).
struct PlanPreviewHost: View {
    @AppStorage("planPreviewScreen") private var screen = "profile-free"
    @State private var showPlus = false

    var body: some View {
        Group {
            switch screen {
            case "profile-limit": profileSample(.freeLimit)
            case "profile-near": profileSample(.freeNear)
            case "profile-plus": profileSample(.plus)
            case "plus-sheet": NavigationStack { PlusSheetView() }
            case "feed-limit": feedSample
            default: profileSample(.freeMid)
            }
        }
        .fontDesign(.rounded).tint(HyggeTheme.sageDeep)
        .buttonStyle(.plain)
        .sheet(isPresented: $showPlus) {
            NavigationStack { PlusSheetView() }.presentationDragIndicator(.visible)
        }
    }

    private func profileSample(_ state: PlanUsageState) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack(spacing: 14) {
                    ZStack {
                        HyggeTheme.sageTint
                        Image(systemName: "person.fill").font(.system(size: 30)).foregroundStyle(HyggeTheme.sageDeep)
                    }.frame(width: 72, height: 72).clipShape(Circle())
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Mikael").font(.system(.title, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink)
                        Text("Edit profile").font(.subheadline.weight(.medium)).foregroundStyle(HyggeTheme.sageDeep)
                    }
                    Spacer(minLength: 4)
                    Image(systemName: "gift").font(.title2).foregroundStyle(HyggeTheme.sageDeep)
                        .frame(width: 48, height: 48).background(HyggeTheme.sageTint, in: RoundedRectangle(cornerRadius: 16))
                }
                VStack(alignment: .leading, spacing: 10) {
                    Text("Design, writing & video").font(.headline).foregroundStyle(HyggeTheme.ink)
                    HStack(spacing: 8) {
                        chip("$30/hr minimum", icon: "dollarsign.circle.fill")
                        chip("Austin, TX", icon: "mappin.circle.fill")
                    }
                }
                VStack(alignment: .leading, spacing: 12) {
                    Text("A little more for you").font(.system(.title3, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink)
                    HStack(alignment: .top, spacing: 12) {
                        metric("Your earnings", value: "$\(Int(state.earnedThisMonth))", asset: "SettingsEarnings", tint: HyggeTheme.butterTint)
                        metric("Time saved", value: "about 3 hr", asset: "SettingsTime", tint: HyggeTheme.sageTint)
                    }
                }
                PlanCardView(state: state, onSeePlus: { showPlus = true })
                VStack(spacing: 0) {
                    SettingsRow(title: "Your logins", icon: "key")
                    Divider()
                    SettingsRow(title: "Approved sites", icon: "link", detail: "\(state.managedSites)")
                    Divider()
                    SettingsRow(title: "Hygge email", icon: "envelope", detail: "Ready")
                    Divider()
                    SettingsRow(title: "Permissions", icon: "slider.horizontal.3", subtitle: "Notifications, calendar & location")
                }
            }
            .padding(.horizontal, 22).padding(.top, 22).padding(.bottom, 24)
        }
        .background(HyggeTheme.paper)
    }

    private var feedSample: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Morning, Mikael").font(.system(.largeTitle, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink)
                PlanLimitCardView(state: .freeLimit, onSeePlus: { showPlus = true })
                VStack(alignment: .leading, spacing: 12) {
                    Text("Journal").font(.system(.title3, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink)
                    journalLine("Nov 28", "Booked a weekend dog sit on Rover — $120 in your calendar.")
                    journalLine("Nov 27", "I checked Rover and Wag; two fits are on your Home screen.")
                    journalLine("Nov 26", "Filed mail from Rover: new message from Alex about Saturday.")
                }
            }
            .padding(.horizontal, 18).padding(.top, 24).padding(.bottom, 24)
        }
        .background(HyggeTheme.paper)
    }

    private func metric(_ label: String, value: String, asset: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Image(asset).resizable().scaledToFit().frame(maxWidth: .infinity).frame(height: 94).accessibilityHidden(true)
            Text(value).font(.system(.title, design: .rounded, weight: .bold)).minimumScaleFactor(0.7)
            Text(label).font(.caption)
        }
        .foregroundStyle(HyggeTheme.ink).padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(tint, in: RoundedRectangle(cornerRadius: 22))
    }

    private func chip(_ text: String, icon: String) -> some View {
        Label(text, systemImage: icon).font(.caption).foregroundStyle(HyggeTheme.secondary)
            .padding(.horizontal, 10).padding(.vertical, 8).background(HyggeTheme.paperDeep, in: Capsule())
    }

    private func journalLine(_ date: String, _ sentence: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(date).font(.caption2.weight(.semibold)).foregroundStyle(HyggeTheme.butterText)
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background(HyggeTheme.butterTint, in: Capsule())
            Text(sentence).font(.subheadline).foregroundStyle(HyggeTheme.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
#endif
