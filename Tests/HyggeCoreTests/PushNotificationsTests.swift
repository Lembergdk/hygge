import XCTest
@testable import HyggeCore

final class PushNotificationsTests: XCTestCase {
    private let taskID = UUID(uuidString: "11111111-2222-5333-A444-555555555555")!
    private let feedID = UUID(uuidString: "AAAAAAAA-BBBB-5CCC-ADDD-EEEEEEEEEEEE")!

    func testPushRouteParsing() {
        XCTAssertEqual(PushDeepLink.parse(route: "task/\(taskID.uuidString.lowercased())"), .task(taskID))
        XCTAssertEqual(PushDeepLink.parse(route: "feed/\(feedID.uuidString.lowercased())"), .feedItem(feedID))
        XCTAssertEqual(PushDeepLink.parse(route: "home"), .home)
        XCTAssertEqual(PushDeepLink.parse(route: nil), .home)
        XCTAssertEqual(PushDeepLink.parse(route: ""), .home)
        XCTAssertEqual(PushDeepLink.parse(route: "task/not-a-uuid"), .home)
        XCTAssertEqual(PushDeepLink.parse(route: "settings/\(taskID.uuidString)"), .home)
        XCTAssertEqual(PushDeepLink.parse(route: "task"), .home)
    }

    func testPushRouteFallbackNeverGuessesAmbiguousNeedsYou() {
        XCTAssertEqual(PushDeepLink.parse(kind: "new_work", ref: feedID.uuidString.lowercased(), refKind: nil),
                       .feedItem(feedID))
        XCTAssertEqual(PushDeepLink.parse(kind: "needs_you", ref: taskID.uuidString.lowercased(), refKind: "task"),
                       .task(taskID))
        // needs_you without a reference kind could be a task or a
        // scan feed item: land on Home, where both are pinned.
        XCTAssertEqual(PushDeepLink.parse(kind: "needs_you", ref: taskID.uuidString.lowercased(), refKind: nil),
                       .home)
        XCTAssertEqual(PushDeepLink.parse(kind: "new_work", ref: nil, refKind: nil), .home)
    }

    func testDeviceTokenHexEncoding() {
        XCTAssertEqual(DeviceTokenEncoding.hexString(from: Data([0x00, 0x0A, 0xFF, 0x5C])), "000aff5c")
        XCTAssertEqual(DeviceTokenEncoding.hexString(from: Data()), "")
        let typical = DeviceTokenEncoding.hexString(from: Data(repeating: 0xAB, count: 32))
        XCTAssertEqual(typical.count, 64)
        XCTAssertTrue(DeviceTokenEncoding.isPlausible(typical))
        XCTAssertTrue(DeviceTokenEncoding.isPlausible(typical.uppercased()))
        XCTAssertFalse(DeviceTokenEncoding.isPlausible("zz"))
        XCTAssertFalse(DeviceTokenEncoding.isPlausible("abcd"))
        XCTAssertFalse(DeviceTokenEncoding.isPlausible(""))
    }

    func testPrimerShowsOnceAfterFirstNotifiableEventOnly() {
        // The one moment it may show.
        XCTAssertTrue(NotificationPrimerPolicy.shouldShowPrimer(
            hasNotifiableEvent: true, primerAlreadyResolved: false,
            authorization: .notDetermined, isSignedIn: true))
        // Never before anything is worth telling them about:
        // not at first launch, not during onboarding.
        XCTAssertFalse(NotificationPrimerPolicy.shouldShowPrimer(
            hasNotifiableEvent: false, primerAlreadyResolved: false,
            authorization: .notDetermined, isSignedIn: true))
        // Never again after it was answered either way.
        XCTAssertFalse(NotificationPrimerPolicy.shouldShowPrimer(
            hasNotifiableEvent: true, primerAlreadyResolved: true,
            authorization: .notDetermined, isSignedIn: true))
        XCTAssertFalse(NotificationPrimerPolicy.shouldShowPrimer(
            hasNotifiableEvent: true, primerAlreadyResolved: false,
            authorization: .denied, isSignedIn: true))
        XCTAssertFalse(NotificationPrimerPolicy.shouldShowPrimer(
            hasNotifiableEvent: true, primerAlreadyResolved: false,
            authorization: .authorized, isSignedIn: true))
        // Signed out there is no account to register a token for.
        XCTAssertFalse(NotificationPrimerPolicy.shouldShowPrimer(
            hasNotifiableEvent: true, primerAlreadyResolved: false,
            authorization: .notDetermined, isSignedIn: false))
    }
}
