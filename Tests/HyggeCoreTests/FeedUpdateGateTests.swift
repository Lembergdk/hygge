import XCTest
@testable import HyggeCore

final class FeedUpdateGateTests: XCTestCase {
    func testOnlyOngoingWorkGetsTheLivePosition() {
        var task = AgentTask(kind: .signup, siteID: "example", targetURLString: "https://example.com", goal: "", title: "Set up account", browserSessionID: "session", status: .running)
        XCTAssertTrue(task.isActiveInFeed)
        task.status = .needsHuman
        XCTAssertTrue(task.isActiveInFeed)
        task.browserSessionID = nil
        XCTAssertFalse(task.isActiveInFeed)
        for status in [AgentTaskStatus.succeeded, .failed, .rejected] {
            task.status = status
            task.browserSessionID = "stale-session"
            XCTAssertFalse(task.isActiveInFeed)
        }
    }

    func testArrivalsAtTopAreAdmittedInPriorityOrder() {
        var gate = FeedUpdateGate()
        gate.receive(["suggestion", "journal"], atTop: true)
        gate.receive(["live", "suggestion", "new-event", "journal"], atTop: true)
        XCTAssertEqual(gate.visibleIDs, ["live", "suggestion", "new-event", "journal"])
        XCTAssertTrue(gate.pendingIDs.isEmpty)
    }

    func testScrolledReaderGetsNoNewCardsOrReordering() {
        var gate = FeedUpdateGate()
        gate.receive(["a", "b"], atTop: true)
        gate.receive(["live", "b", "a", "event"], atTop: false)
        XCTAssertEqual(gate.visibleIDs, ["a", "b"])
        XCTAssertEqual(gate.pendingIDs, ["live", "event"])
        gate.receive(["live", "b", "a", "event"], atTop: true)
        XCTAssertEqual(gate.visibleIDs, ["live", "b", "a", "event"])
        XCTAssertTrue(gate.pendingIDs.isEmpty)
    }

    func testFinishedSessionIsRemovedAndJournalEntryWaits() {
        var gate = FeedUpdateGate()
        gate.receive(["live", "suggestion"], atTop: true)
        gate.receive(["suggestion", "completion"], atTop: false)
        XCTAssertEqual(gate.visibleIDs, ["suggestion"])
        XCTAssertEqual(gate.pendingIDs, ["completion"])
        gate.receive(["suggestion", "completion"], atTop: true)
        XCTAssertEqual(gate.visibleIDs, ["suggestion", "completion"])
    }

    func testPendingWithdrawalAndEmptyFeedDoNotAccidentallyFlush() {
        var gate = FeedUpdateGate()
        gate.receive(["a"], atTop: true)
        gate.receive(["b", "b"], atTop: false)
        XCTAssertTrue(gate.visibleIDs.isEmpty)
        XCTAssertEqual(gate.pendingIDs, ["b"])
        gate.receive(["c"], atTop: false)
        XCTAssertTrue(gate.visibleIDs.isEmpty)
        XCTAssertEqual(gate.pendingIDs, ["c"])
    }

    func testUndoRestoresOnlyItsCardWithoutFlushingPendingUpdates() {
        var gate = FeedUpdateGate()
        gate.receive(["a", "b"], atTop: true)
        gate.receive(["new", "b"], atTop: false)
        gate.restore("a", at: 0)
        gate.receive(["new", "a", "b"], atTop: false)
        XCTAssertEqual(gate.visibleIDs, ["a", "b"])
        XCTAssertEqual(gate.pendingIDs, ["new"])
    }
}
