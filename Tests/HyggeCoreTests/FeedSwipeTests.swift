import XCTest
@testable import HyggeCore

final class FeedSwipeTests: XCTestCase {
    func testShortSwipesRevealInsteadOfTriggering() {
        XCTAssertEqual(FeedSwipe.outcome(offset: 80, width: 360), .revealed(1))
        XCTAssertEqual(FeedSwipe.outcome(offset: -80, width: 360), .revealed(-1))
    }
    func testLongSwipesTriggerOnlyAtVisibleThreshold() {
        let threshold = FeedSwipe.threshold(width: 360)
        XCTAssertEqual(FeedSwipe.outcome(offset: threshold - 1, width: 360), .revealed(1))
        XCTAssertEqual(FeedSwipe.outcome(offset: threshold, width: 360), .triggered(1))
        XCTAssertEqual(FeedSwipe.outcome(offset: -threshold, width: 360), .triggered(-1))
    }
    func testRetreatAndSmallMovementDoNotCommit() {
        XCTAssertEqual(FeedSwipe.outcome(offset: 20, width: 360), .closed)
        XCTAssertEqual(FeedSwipe.outcome(offset: -20, width: 360), .closed)
        // A gesture can cross the threshold and retreat. Only release matters.
        _ = FeedSwipe.outcome(offset: 280, width: 360)
        XCTAssertEqual(FeedSwipe.outcome(offset: 92, width: 360), .revealed(1))
    }
    func testThresholdAdaptsToLandscapeAndRejectsInvalidGeometry() {
        XCTAssertEqual(FeedSwipe.outcome(offset: 250, width: 700), .revealed(1))
        XCTAssertEqual(FeedSwipe.outcome(offset: 450, width: 700), .triggered(1))
        XCTAssertEqual(FeedSwipe.outcome(offset: 100, width: 0), .closed)
        XCTAssertEqual(FeedSwipe.outcome(offset: .nan, width: 360), .closed)
    }
}
