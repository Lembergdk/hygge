import XCTest
@testable import HyggeCore

final class ProfileRateInputTests: XCTestCase {
    func testCompleteRatesAndZeroAreAccepted() {
        let locale = Locale(identifier: "en_US")
        XCTAssertEqual(ProfileRateInput.parse("25.50", locale: locale), 25.5)
        XCTAssertEqual(ProfileRateInput.parse("0", locale: locale), 0)
        XCTAssertEqual(ProfileRateInput.parse(" 125 ", locale: locale), 125)
    }
    func testPartialOrMalformedTypingDoesNotReplaceSavedRate() {
        for value in ["", ".", "25.", "2..5", "25abc", "1,000", "-1", "NaN", "∞"] {
            XCTAssertNil(ProfileRateInput.parse(value, locale: Locale(identifier: "en_US")), value)
        }
    }
    func testDecimalCommaLocale() {
        let locale = Locale(identifier: "da_DK")
        XCTAssertEqual(ProfileRateInput.parse("25,50", locale: locale), 25.5)
        XCTAssertNil(ProfileRateInput.parse("25.50", locale: locale))
        XCTAssertNil(ProfileRateInput.parse("25,", locale: locale))
    }
}
