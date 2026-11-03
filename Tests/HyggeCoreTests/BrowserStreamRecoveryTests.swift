import XCTest
@testable import HyggeCore

final class BrowserStreamRecoveryTests: XCTestCase {
    func testRepeatedFailuresStopAndManualRetryGetsFreshBudget() {
        var recovery = BrowserStreamRecovery()
        XCTAssertEqual(recovery.disconnected(httpStatus: nil), .retry)
        XCTAssertEqual(recovery.disconnected(httpStatus: 503), .retry)
        XCTAssertEqual(recovery.disconnected(httpStatus: nil), .unavailable)
        recovery = BrowserStreamRecovery()
        XCTAssertEqual(recovery.disconnected(httpStatus: nil), .retry)
    }
    func testExpiredAndUnauthenticatedSessionsDoNotRetry() {
        for status in [404, 410] {
            var recovery = BrowserStreamRecovery()
            XCTAssertEqual(recovery.disconnected(httpStatus: status), .ended)
        }
        for status in [401, 403] {
            var recovery = BrowserStreamRecovery()
            XCTAssertEqual(recovery.disconnected(httpStatus: status), .signInRequired)
        }
        var recovery = BrowserStreamRecovery()
        XCTAssertEqual(recovery.disconnected(httpStatus: 101, normallyClosed: true), .ended)
    }
    func testFlappingDoesNotResetBudgetButHealthyStaticPageDoes() {
        var recovery = BrowserStreamRecovery()
        let now = Date()
        XCTAssertEqual(recovery.disconnected(httpStatus: nil), .retry)
        recovery.receivedResponse(at: now)
        recovery.receivedResponse(at: now.addingTimeInterval(5))
        XCTAssertEqual(recovery.disconnected(httpStatus: nil), .retry)
        recovery.receivedResponse(at: now.addingTimeInterval(6))
        XCTAssertEqual(recovery.disconnected(httpStatus: nil), .unavailable)
        recovery.receivedResponse(at: now.addingTimeInterval(7))
        recovery.receivedResponse(at: now.addingTimeInterval(38))
        XCTAssertEqual(recovery.disconnected(httpStatus: nil), .retry)
        XCTAssertEqual(recovery.failures, 1)
    }
}
