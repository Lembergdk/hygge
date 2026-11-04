import XCTest
@testable import HyggeCore

final class ChatActionBatchTests: XCTestCase {
    @MainActor
    func testBothAddsExecuteInOrder() async {
        let actions: [ChatAction] = [.addSite(domain: "contra.com"), .addSite(domain: "toptal.com")]
        var executed: [ChatAction] = []
        let progress = await ChatActionBatch.run(actions.map(ChatBatchItem.action)) {
            executed.append($0); return "Started \(executed.count)"
        }
        XCTAssertEqual(executed, actions)
        XCTAssertEqual(progress.replies, ["Started 1", "Started 2"])
        XCTAssertNil(progress.confirmation)
        XCTAssertTrue(progress.remaining.isEmpty)
    }

    @MainActor
    func testResumeThenScanDoesNotDropSecondAction() async {
        var paused = true
        let progress = await ChatActionBatch.run([.action(.resume), .action(.scanSite(siteID: "rover"))]) {
            if $0 == .resume { paused = false; return "Resumed" }
            return paused ? "Paused" : "Looking on Rover"
        }
        XCTAssertEqual(progress.replies, ["Resumed", "Looking on Rover"])
    }

    @MainActor
    func testMixedBatchStopsAtEachConfirmationAndKeepsRemainder() async {
        var executed: [ChatAction] = []
        let items: [ChatBatchItem] = [.action(.scanSite(siteID: "rover")), .action(.approveFirst),
                                     .action(.bookFirst), .action(.pause)]
        let first = await ChatActionBatch.run(items) { executed.append($0); return "Looking on Rover" }
        XCTAssertEqual(executed, [.scanSite(siteID: "rover")])
        XCTAssertEqual(first.confirmation, .approveFirst)
        XCTAssertEqual(first.remaining, [.action(.bookFirst), .action(.pause)])
        let next = await ChatActionBatch.run(first.remaining) { executed.append($0); return "Unexpected" }
        XCTAssertEqual(next.confirmation, .bookFirst)
        XCTAssertEqual(next.remaining, [.action(.pause)])
        XCTAssertEqual(executed, [.scanSite(siteID: "rover")])
        let final = await ChatActionBatch.run(next.remaining) { executed.append($0); return "Paused" }
        XCTAssertEqual(final.replies, ["Paused"])
        XCTAssertNil(final.confirmation)
    }

    @MainActor
    func testUnavailableAndExecutionFailuresRemainVisibleAlongsideSuccess() async {
        let progress = await ChatActionBatch.run([
            .unavailable("Site no longer exists"), .action(.scanSite(siteID: "rover")), .action(.resume)
        ]) { $0 == .resume ? "Resumed" : "Still setting up Rover" }
        XCTAssertEqual(progress.replies, ["Site no longer exists", "Still setting up Rover", "Resumed"])
    }
}
