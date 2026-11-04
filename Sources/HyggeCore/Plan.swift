import Foundation

/// The pricing scheme, as pure accounting (no store, no I/O):
///
/// - Free covers the first $100 of *logged* earnings each
///   calendar month — logged means witnessed completions
///   (`workCompleted` events with a structured amount), the same
///   definition earnings have always used. Bookings don't count.
/// - Free manages up to 10 job sites (joined and watched).
/// - At $100, Free rests: no new searches, drafts, or joins until
///   the 1st. Work already under way is untouched.
/// - Plus ($9.99/month) is unlimited. Neither tier ever takes a
///   cut of the user's pay.
public enum PlanTier: String, Codable, Sendable, Equatable {
    case free, plus
}

public enum Plan {
    public static let freeMonthlyEarningsLimit = 100.0
    public static let freeSiteLimit = 10
    public static let plusProductID = "app.usehygge.plus.monthly"

    /// Logged earnings in the calendar month containing `now`:
    /// witnessed completions with amounts, nothing else.
    public static func monthlyLoggedEarnings(events: [ActivityEvent], now: Date,
                                             calendar: Calendar = .current) -> Double {
        let parts = calendar.dateComponents([.year, .month], from: now)
        return events
            .filter { event in
                guard event.kind == .workCompleted, event.grossAmount != nil else { return false }
                let when = calendar.dateComponents([.year, .month], from: event.occurredAt)
                return when.year == parts.year && when.month == parts.month
            }
            .compactMap(\.grossAmount)
            .reduce(0, +)
    }

    public static func isRested(tier: PlanTier, monthlyEarnings: Double) -> Bool {
        tier == .free && monthlyEarnings >= freeMonthlyEarningsLimit
    }

    /// The 1st of next month — when a rested Free plan wakes.
    public static func nextMonthStart(after date: Date, calendar: Calendar = .current) -> Date {
        let parts = calendar.dateComponents([.year, .month], from: date)
        let thisMonth = calendar.date(from: parts) ?? date
        return calendar.date(byAdding: .month, value: 1, to: thisMonth) ?? date
    }

    /// Sites Hygge actively manages: joined and ready/watching.
    /// Suggestions, in-progress joins, and stopped sites don't
    /// count against the free cap.
    public static func managedSiteCount(_ states: [String: SiteAccountState]) -> Int {
        states.values.filter { $0 == .hasAccount || $0 == .profileLive || $0 == .watching }.count
    }

    public static func canManageAnotherSite(tier: PlanTier, managedSites: Int) -> Bool {
        tier == .plus || managedSites < freeSiteLimit
    }
}

/// A point-in-time reading of plan state for UI and gates.
/// Computed from witnessed facts; never stored as truth.
public struct PlanSnapshot: Equatable, Sendable {
    public var tier: PlanTier
    public var monthlyEarnings: Double
    public var managedSites: Int
    public var rested: Bool
    public var restartsAt: Date

    public init(tier: PlanTier, monthlyEarnings: Double, managedSites: Int,
                rested: Bool, restartsAt: Date) {
        self.tier = tier
        self.monthlyEarnings = monthlyEarnings
        self.managedSites = managedSites
        self.rested = rested
        self.restartsAt = restartsAt
    }

    public static func make(tier: PlanTier, events: [ActivityEvent],
                            states: [String: SiteAccountState], now: Date,
                            calendar: Calendar = .current) -> PlanSnapshot {
        let earnings = Plan.monthlyLoggedEarnings(events: events, now: now, calendar: calendar)
        return PlanSnapshot(
            tier: tier,
            monthlyEarnings: earnings,
            managedSites: Plan.managedSiteCount(states),
            rested: Plan.isRested(tier: tier, monthlyEarnings: earnings),
            restartsAt: Plan.nextMonthStart(after: now, calendar: calendar))
    }
}
