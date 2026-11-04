import XCTest
@testable import HyggeCore

final class PersistentConversationTests: XCTestCase {
    func testSavedTurnAndExactDeviceProposalDecodeTogether() throws {
        let json = #"""
        {"conversationID":"conversation","generation":"generation","activeTurn":{"id":"turn","text":"Add both"},"cleanupPending":2,"replyMessageId":"04901bba-45bd-4ecf-a14a-9263baccc820","proposals":[{"id":"proposal","generation":"generation","title":"Approve this appointment?","operation":"book_task","status":"completed","details":{"Destination":"Calendar","Title":"Synthetic gig"},"result":{"status":"device_required","taskId":"task","payload":{"title":"Synthetic gig","date":"2026-11-10"}}}]}
        """#
        let state = try JSONDecoder().decode(PersistentConversationState.self, from: Data(json.utf8))
        XCTAssertEqual(state.activeTurn?.text, "Add both")
        XCTAssertEqual(state.proposals.first?.result?.payload?["title"], "Synthetic gig")
        XCTAssertEqual(state.cleanupPending, 2)
        XCTAssertNotNil(state.replyMessageId)
    }

    func testServerCreatedTaskProjectionDecodesAsARealAgentTask() throws {
        let json = #"""
        {"id":"04901bba-45bd-4ecf-a14a-9263baccc820","kind":"signup","siteID":"contra.com","targetURLString":"https://contra.com","title":"Join Contra","goal":"Set up my account","draftedPayload":{"displayName":"Synthetic Tester"},"status":"awaitingApproval","log":[],"createdAt":815184000,"backendTaskID":"04901bba-45bd-4ecf-a14a-9263baccc820","browserSessionID":null,"browserTrace":[],"informationRequests":[],"help":null,"pendingReply":null}
        """#
        let task = try JSONDecoder().decode(AgentTask.self, from: Data(json.utf8))
        XCTAssertEqual(task.kind, .signup)
        XCTAssertEqual(task.status, .awaitingApproval)
        XCTAssertEqual(task.draftedPayload["displayName"], "Synthetic Tester")
        XCTAssertEqual(task.domain, "contra.com")
    }

    func testFocusCarriesOnlyLookupKeys() throws {
        let focus = PersistentChatFocus(kind: "task", id: "owned-task")
        let decoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(focus)) as? [String: String]
        XCTAssertEqual(decoded, ["kind": "task", "id": "owned-task"])
    }
}
