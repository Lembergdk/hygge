import XCTest
@testable import HyggeCore

final class ReceivedEmailTests: XCTestCase {
    func testLegacyMessagesKeepTheirSubjectAndDecodeWithoutNewFields() throws {
        let data = Data(#"{"id":"legacy","sender":"Jane <jane@example.com>","senderDomain":"example.com","subject":"Original subject","kind":"other","summary":"Saved summary","actionableItems":[],"attachments":[]}"#.utf8)
        let mail = try JSONDecoder().decode(FiledEmailSummary.self, from: data)
        XCTAssertEqual(mail.displayTitle, "Original subject")
        XCTAssertEqual(mail.senderAddress, "Jane <jane@example.com>")
        XCTAssertNil(mail.hasOriginal)
        XCTAssertNil(mail.markedAsMe)
    }
    func testGeneratedTitleDoesNotReplaceOriginalSubjectOrSender() throws {
        let data = Data(#"{"id":"new","title":"A project inquiry","senderEmail":"jane@example.com","sender":"Jane","senderDomain":"example.com","subject":"RE: Café branding","kind":"other","summary":"A client asks about timing.","actionableItems":[],"attachments":[],"markedAsMe":true,"date":"2026-11-04T18:00:00.123Z"}"#.utf8)
        let mail = try JSONDecoder().decode(FiledEmailSummary.self, from: data)
        XCTAssertEqual(mail.displayTitle, "A project inquiry")
        XCTAssertEqual(mail.subject, "RE: Café branding")
        XCTAssertEqual(mail.senderAddress, "jane@example.com")
        XCTAssertNotNil(mail.receivedAt)
        XCTAssertEqual(mail.markedAsMe, true)
    }
    func testOriginalAndPendingAddressDecodeWithoutGrantingVerification() throws {
        let original = try JSONDecoder().decode(OriginalEmail.self, from: Data(#"{"from":"Jane <jane@example.com>","to":"1234567890@usehygge.cc","subject":"Full subject","text":"Full original body","html":"<p>Full original body</p>","truncated":false}"#.utf8))
        XCTAssertEqual(original.text, "Full original body")
        XCTAssertEqual(original.subject, "Full subject")
        let address = try JSONDecoder().decode(OwnEmailAddress.self, from: Data(#"{"address":"me@example.com","verified":false,"source":"added","verificationSubject":"Hygge verify abc"}"#.utf8))
        XCTAssertFalse(address.verified)
        XCTAssertEqual(address.id, "me@example.com")
    }
}
