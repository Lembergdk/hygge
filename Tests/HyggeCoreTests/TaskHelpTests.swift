import XCTest
@testable import HyggeCore

final class TaskHelpTests: XCTestCase {
    func task() -> AgentTask {
        AgentTask(kind: .signup, siteID: "example", targetURLString: "https://example.com",
                  goal: "Connect account", title: "Connect", status: .needsHuman)
    }
    func testConnectionDoesNotDraftProfileChanges() {
        let task = AgentTaskFactory.connectTask(profile: EarningsProfile(), site: SeedSites.all[0])
        XCTAssertTrue(task.connectsExistingAccount)
        XCTAssertNil(task.draftedPayload["profileBio"])
        XCTAssertTrue(task.goal.contains("Never create another account"))
    }
    func testAnswersContinueOriginalScopeOneQuestionAtATime() {
        var task = task()
        let request = TaskHelp(kind: .information, message: "Details", questions: [.init(text: "Where?"), .init(text: "When?")])
        task.help = request
        XCTAssertTrue(task.prepareReply(helpID: request.id, answers: ["Where?": "Austin"]))
        XCTAssertEqual(task.pendingReply?.approved, false)
        XCTAssertEqual(task.status, .needsHuman)
        XCTAssertFalse(task.prepareReply(helpID: request.id, answers: [:]))
        XCTAssertFalse(task.prepareReply(helpID: request.id, answers: ["Wrong question": "Austin"]))
    }
    func testStaleReplyAndImplicitConsentAreRejected() {
        var task = task()
        let request = TaskHelp(kind: .approval, message: "Publish?")
        task.help = request
        XCTAssertFalse(task.prepareReply(helpID: UUID(), approved: true))
        XCTAssertFalse(task.prepareReply(helpID: request.id, answers: ["yes": "yes"]))
        XCTAssertTrue(task.prepareReply(helpID: request.id, approved: true))
        task.status = .running
        XCTAssertFalse(task.prepareReply(helpID: request.id, approved: true))
    }
    func testOldCachesStillDecodeAndHelpLinksSurviveRoundTrip() throws {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(task())) as! [String: Any]
        for key in ["help", "pendingReply", "backendTaskID"] { object.removeValue(forKey: key) }
        XCTAssertNil(try JSONDecoder().decode(AgentTask.self, from: JSONSerialization.data(withJSONObject: object)).help)
        let entry = ChatEntry(fromAgent: true, text: "Hello", taskID: task().id, helpID: UUID())
        XCTAssertEqual(try JSONDecoder().decode(ChatEntry.self, from: JSONEncoder().encode(entry)), entry)
        let old = ChatEntry(fromAgent: true, text: "Before this update")
        XCTAssertNil(try JSONDecoder().decode(ChatEntry.self, from: JSONEncoder().encode(old)).taskID)
    }
}
