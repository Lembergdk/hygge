import XCTest
@testable import HyggeCore

/// "So check it" / "Well do something about it" after a forwarded
/// email was discussed must resolve to that mail — the user should
/// never be bounced to reciting an exact phrase.
final class EmailReferenceTests: XCTestCase {
    private let apartmentMail = FiledEmailSummary(
        id: "m1", sender: "Sam <sam@gmail.com>", senderDomain: "gmail.com",
        subject: "Fwd: New maintenance jobs at ApartmentIQ",
        kind: "other",
        summary: "ApartmentIQ posted 4 new maintenance technician jobs near Leeds this week. Apply on their site.",
        actionableItems: ["Link to apartmentiq.com"],
        relation: "unknown", decision: "pending",
        highlights: ["Possible new work mentioned"])
    private let roverMail = FiledEmailSummary(
        id: "m2", sender: "Rover <no-reply@rover.com>", senderDomain: "rover.com",
        subject: "New message from Alex",
        kind: "other",
        summary: "Alex sent you a message about Saturday.",
        actionableItems: ["Link to rover.com"],
        relation: "site", decision: "work",
        highlights: ["Someone may have messaged you"], siteID: "rover")

    private var inbox: [FiledEmailSummary] { [apartmentMail, roverMail] }

    func testExplicitSenderReferenceResolves() {
        let hit = EmailReferenceResolver.resolve(
            text: "what did the ApartmentIQ email say?",
            recentTranscript: [], inbox: inbox)
        XCTAssertEqual(hit?.mail.id, "m1")
        XCTAssertEqual(hit?.wantsAction, false) // a reading question, not an instruction
    }

    func testContextualFollowUpsResolveToDiscussedMail() {
        let transcript = [
            "I forwarded you an ApartmentIQ email with some jobs",
            "Got it — you mean that ApartmentIQ forward.",
        ]
        let check = EmailReferenceResolver.resolve(
            text: "So check it", recentTranscript: transcript, inbox: inbox)
        XCTAssertEqual(check?.mail.id, "m1")
        XCTAssertEqual(check?.wantsAction, true)

        let act = EmailReferenceResolver.resolve(
            text: "Well do something about it.", recentTranscript: transcript, inbox: inbox)
        XCTAssertEqual(act?.mail.id, "m1")
        XCTAssertEqual(act?.wantsAction, true)
    }

    func testUnrelatedAndNegatedMessagesDoNotResolve() {
        XCTAssertNil(EmailReferenceResolver.resolve(
            text: "check it out, the weather is lovely today",
            recentTranscript: ["Morning!"], inbox: inbox))
        XCTAssertNil(EmailReferenceResolver.resolve(
            text: "don't check that ApartmentIQ email",
            recentTranscript: [], inbox: inbox))
        XCTAssertNil(EmailReferenceResolver.resolve(
            text: "how's your day going?",
            recentTranscript: ["ApartmentIQ ApartmentIQ"], inbox: inbox))
    }

    func testGateOnlyFiresWhenMailCouldBeMeant() {
        XCTAssertFalse(EmailReferenceResolver.mightConcernEmail(
            text: "hello there", recentTranscript: [], inbox: inbox))
        XCTAssertTrue(EmailReferenceResolver.mightConcernEmail(
            text: "So check it",
            recentTranscript: ["that ApartmentIQ forward"], inbox: inbox))
        XCTAssertTrue(EmailReferenceResolver.mightConcernEmail(
            text: "check your email", recentTranscript: [], inbox: inbox))
        // Nothing cached yet, but the talk was about a forward.
        XCTAssertTrue(EmailReferenceResolver.mightConcernEmail(
            text: "So check it",
            recentTranscript: ["I forwarded you an email just now"], inbox: []))
    }

    func testLinkHostsAreExtractedFromActionableItems() {
        XCTAssertEqual(EmailReferenceResolver.linkHosts(in: apartmentMail), ["apartmentiq.com"])
        XCTAssertEqual(EmailReferenceResolver.linkHosts(in: roverMail), ["rover.com"])
    }
}
