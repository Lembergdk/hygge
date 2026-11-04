import XCTest
@testable import HyggeCore

/// "Chat about this" context (2026-11-04): the stamp on a chat
/// entry must round-trip, and transcripts saved before it
/// existed must still decode.
final class ChatContextTests: XCTestCase {

    func testContextRoundTrips() throws {
        let entry = ChatEntry(
            fromAgent: false, text: "Help me apply for this one",
            context: ChatContextRef(kind: "opportunity", id: "opp-1",
                                     title: "Ghostwrite posts", subtitle: "$60/hr",
                                     siteID: "upwork.com", siteDomain: "upwork.com"))
        let data = try JSONEncoder().encode(entry)
        let decoded = try JSONDecoder().decode(ChatEntry.self, from: data)
        XCTAssertEqual(decoded, entry)
        XCTAssertEqual(decoded.context?.siteID, "upwork.com")
    }

    func testLegacyEntryWithoutContextDecodes() throws {
        let legacy = #"{"id":"9E2A3B8C-0000-4000-8000-000000000001","fromAgent":true,"text":"Hey","createdAt":700000000}"#
        let decoded = try JSONDecoder().decode(ChatEntry.self, from: Data(legacy.utf8))
        XCTAssertEqual(decoded.text, "Hey")
        XCTAssertNil(decoded.context)
    }
}
