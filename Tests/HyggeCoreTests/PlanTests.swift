import XCTest
@testable import HyggeCore

/// Pricing scheme math: Free covers the first $100 of logged
/// (witnessed, completed) earnings per calendar month and 10
/// managed sites; at the limit, new work rests until the 1st.
final class PlanTests: XCTestCase {
    private var calendar: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "America/Chicago")!
        return cal
    }
    private func date(_ y: Int, _ m: Int, _ d: Int) -> Date {
        calendar.date(from: DateComponents(year: y, month: m, day: d))!
    }
    private func completed(_ amount: Double, on day: Date) -> ActivityEvent {
        ActivityEvent(occurredAt: day, kind: .workCompleted, sentence: "Done", grossAmount: amount)
    }

    func testMonthlyLoggedEarningsCountsOnlyCompletedWorkThisMonth() {
        let events = [
            completed(60, on: date(2026, 11, 3)),
            completed(52, on: date(2026, 11, 28)),
            completed(200, on: date(2026, 10, 31)),   // last month: excluded
            ActivityEvent(occurredAt: date(2026, 11, 10), kind: .booked, sentence: "Booked", grossAmount: 500), // booked != earned
            ActivityEvent(occurredAt: date(2026, 11, 12), kind: .workCompleted, sentence: "No amount"),          // unwitnessed amount
        ]
        XCTAssertEqual(Plan.monthlyLoggedEarnings(events: events, now: date(2026, 11, 15), calendar: calendar), 112)
        XCTAssertEqual(Plan.monthlyLoggedEarnings(events: events, now: date(2026, 12, 1), calendar: calendar), 0)
    }

    func testRestedOnlyForFreeAtLimit() {
        let now = date(2026, 11, 15)
        XCTAssertTrue(Plan.isRested(tier: .free, monthlyEarnings: 100))
        XCTAssertTrue(Plan.isRested(tier: .free, monthlyEarnings: 112))
        XCTAssertFalse(Plan.isRested(tier: .free, monthlyEarnings: 99.99))
        XCTAssertFalse(Plan.isRested(tier: .plus, monthlyEarnings: 10_000))
        XCTAssertEqual(Plan.nextMonthStart(after: now, calendar: calendar), date(2026, 12, 1))
    }

    func testManagedSitesAndCap() {
        let states: [String: SiteAccountState] = [
            "a": .watching, "b": .hasAccount, "c": .profileLive,
            "d": .proposed, "e": .joining, "f": .stopped, "g": .disconnected,
        ]
        XCTAssertEqual(Plan.managedSiteCount(states), 3)
        XCTAssertTrue(Plan.canManageAnotherSite(tier: .free, managedSites: 9))
        XCTAssertFalse(Plan.canManageAnotherSite(tier: .free, managedSites: 10))
        XCTAssertTrue(Plan.canManageAnotherSite(tier: .plus, managedSites: 400))
    }
}
