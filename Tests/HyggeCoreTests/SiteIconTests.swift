import XCTest
@testable import HyggeCore

final class SiteIconTests: XCTestCase {
    func testCandidatesPreferTouchIconOnBareHost() {
        let urls = SiteIcon.candidateURLs(domain: "www.upwork.com")
        XCTAssertEqual(urls.map(\.absoluteString), [
            "https://upwork.com/apple-touch-icon.png",
            "https://upwork.com/favicon.ico",
        ])
    }

    func testCandidatesAcceptFullURL() {
        let urls = SiteIcon.candidateURLs(domain: "https://contra.com/hire")
        XCTAssertEqual(urls.first?.absoluteString, "https://contra.com/apple-touch-icon.png")
    }

    func testNoCandidatesWithoutAHost() {
        XCTAssertTrue(SiteIcon.candidateURLs(domain: "").isEmpty)
        XCTAssertTrue(SiteIcon.candidateURLs(domain: "localhost").isEmpty)
    }

    func testMonogram() {
        XCTAssertEqual(SiteIcon.monogram(for: "Upwork"), "U")
        XCTAssertEqual(SiteIcon.monogram(for: "  rover"), "R")
        XCTAssertEqual(SiteIcon.monogram(for: "99designs"), "9")
        XCTAssertEqual(SiteIcon.monogram(for: "—"), "?")
    }
}
