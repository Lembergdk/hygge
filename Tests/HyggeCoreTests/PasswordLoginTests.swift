import XCTest
@testable import HyggeCore

final class PasswordLoginTests: XCTestCase {
    func testEmailActionsOnlyAppearForFocusOrValidEmail() {
        for email in ["", "sam", "sam@", "bad@@example.com", "sam\n@example.com"] {
            XCTAssertFalse(HyggeAuth.showsEmailActions(email: email, isFocused: false), email)
            XCTAssertTrue(HyggeAuth.showsEmailActions(email: email, isFocused: true), email)
        }
        XCTAssertTrue(HyggeAuth.showsEmailActions(email: " Sam@example.com ", isFocused: false))
    }

    func testPasswordLengthCountsUnicodeScalarsLikeServer() {
        XCTAssertFalse(HyggeAuth.isValidPassword("too short"))
        XCTAssertTrue(HyggeAuth.isValidPassword(String(repeating: "🍂", count: 15)))
        XCTAssertTrue(HyggeAuth.isValidPassword(String(repeating: "a", count: 128)))
        XCTAssertFalse(HyggeAuth.isValidPassword(String(repeating: "a", count: 129)))
    }

    func testMethodsFromOlderServersDecodeWithoutPasswordFlag() throws {
        let data = Data(#"{"id":"email","method":"email","email":"sam@example.com","emailVerified":true}"#.utf8)
        let method = try JSONDecoder().decode(LinkedLoginMethod.self, from: data)
        XCTAssertFalse(method.hasPassword)
        XCTAssertTrue(method.emailVerified)
    }
}
