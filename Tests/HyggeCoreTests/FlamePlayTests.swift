import XCTest
@testable import HyggeCore

final class FlamePlayTests: XCTestCase {
    func testTapZones() {
        XCTAssertEqual(FlameGestureClassifier.classify(
            translationX: 2, translationY: 3, predictedX: 4, predictedY: 5,
            tapNormalizedY: 0.15), .tapHead)
        XCTAssertEqual(FlameGestureClassifier.classify(
            translationX: -3, translationY: 2, predictedX: -4, predictedY: 3,
            tapNormalizedY: 0.55), .tapBody)
        XCTAssertEqual(FlameGestureClassifier.classify(
            translationX: 1, translationY: -2, predictedX: 2, predictedY: -3,
            tapNormalizedY: 0.9), .tapFeet)
    }

    func testSwipeGesturesBeatTapZones() {
        XCTAssertEqual(FlameGestureClassifier.classify(
            translationX: 10, translationY: -80, predictedX: 12, predictedY: -160,
            tapNormalizedY: 0.1), .swipeUp)
        XCTAssertEqual(FlameGestureClassifier.classify(
            translationX: -70, translationY: 4, predictedX: -150, predictedY: 8,
            tapNormalizedY: 0.9), .swipeLeft)
        XCTAssertNil(FlameGestureClassifier.classify(
            translationX: 30, translationY: 25, predictedX: 50, predictedY: 45,
            tapNormalizedY: 0.5))
    }

    func testSettingsDefaultsAndRoundTrip() throws {
        let settings = FlameInteractionSettings()
        XCTAssertEqual(settings.homeFlameSize, 122)
        XCTAssertEqual(settings.liveliness, 1.35, accuracy: 0.001)
        XCTAssertEqual(settings.reaction(for: .tapHead), .pat)
        XCTAssertEqual(settings.reaction(for: .swipeUp), .bigJump)
        XCTAssertEqual(settings.reaction(for: .shake), .nauseous)
        XCTAssertNil(settings.placement)
        XCTAssertEqual(settings.description(for: .tapHead), "")

        var custom = settings
        custom.setReaction(.twirl, for: .swipeRight)
        custom.setDescription("Do a little bow", for: .tapHead)
        custom.placement = FlamePlacement(x: 0.25, y: 1.7)
        let decoded = try JSONDecoder().decode(
            FlameInteractionSettings.self,
            from: JSONEncoder().encode(custom))
        XCTAssertEqual(decoded.reaction(for: .swipeRight), .twirl)
        XCTAssertEqual(decoded.description(for: .tapHead), "Do a little bow")
        XCTAssertEqual(decoded.placement, FlamePlacement(x: 0.25, y: 1))
        custom.setDescription("   ", for: .tapHead)
        XCTAssertEqual(custom.description(for: .tapHead), "")
        XCTAssertEqual(try JSONDecoder().decode(
            FlameInteractionSettings.self, from: Data("{}".utf8)),
                       FlameInteractionSettings())
    }

    func testClampedSettings() {
        var settings = FlameInteractionSettings()
        settings.homeFlameSize = 500
        settings.liveliness = 99
        settings.idleInterval = 0
        settings.clamp()
        XCTAssertLessThanOrEqual(settings.homeFlameSize, 170)
        XCTAssertLessThanOrEqual(settings.liveliness, 2)
        XCTAssertGreaterThanOrEqual(settings.idleInterval, 2.5)
    }

    func testIdlePlannerCyclesWithVariedDelays() {
        var planner = FlameIdlePlanner()
        let sequence = (0..<7).map { _ in planner.next().action }
        XCTAssertEqual(Set(sequence.dropLast()).count, 6)
        XCTAssertEqual(sequence.last, sequence.first)
    }

    func testShakeDetectorCooldown() {
        var detector = FlameShakeDetector()
        XCTAssertFalse(detector.consume(x: 0.2, y: 0.1, z: 0, at: 0))
        XCTAssertTrue(detector.consume(x: 1.8, y: 0.4, z: 0, at: 1))
        XCTAssertFalse(detector.consume(x: 2, y: 0, z: 0, at: 1.4))
        XCTAssertTrue(detector.consume(x: -1.9, y: 0.2, z: 0, at: 2.2))
    }

    func testSpringStillConvergesAtLivelyDefaults() {
        var spring = FlameSpring()
        for _ in 0..<240 {
            spring.step(toward: FlameTilt(x: 0.5, y: -0.25), deltaTime: 1.0 / 60)
        }
        XCTAssertEqual(spring.value.x, 0.5, accuracy: 0.01)
        XCTAssertEqual(spring.value.y, -0.25, accuracy: 0.01)
    }
}
