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

    func testFlickVersusDragRelease() {
        // Slow carry: finger travelled far, predicted barely beyond it.
        XCTAssertFalse(FlameGestureClassifier.isFlickRelease(
            translationX: 0, translationY: -140, predictedX: 0, predictedY: -165))
        // Hard flick up: short travel, big predicted overshoot.
        XCTAssertTrue(FlameGestureClassifier.isFlickRelease(
            translationX: 0, translationY: -45, predictedX: 0, predictedY: -260))
        // Fast side flick after some drag distance.
        XCTAssertTrue(FlameGestureClassifier.isFlickRelease(
            translationX: 90, translationY: 5, predictedX: 280, predictedY: 10))
        // Diagonal mush is neither a clean swipe nor a flick.
        XCTAssertFalse(FlameGestureClassifier.isFlickRelease(
            translationX: 40, translationY: -40, predictedX: 150, predictedY: -150))
        // Tiny movement never flicks.
        XCTAssertFalse(FlameGestureClassifier.isFlickRelease(
            translationX: 3, translationY: -4, predictedX: 5, predictedY: -8))
    }

    func testDragIntentBuffer() {
        // Fresh touch, barely moved: still deciding — show nothing yet.
        XCTAssertEqual(FlameGestureClassifier.dragIntent(
            elapsed: 0.04, magnitude: 6, velocity: 120), .deciding)
        // Fast early movement: arm as a flick (anticipation, no following).
        XCTAssertEqual(FlameGestureClassifier.dragIntent(
            elapsed: 0.07, magnitude: 30, velocity: 1100), .flick)
        // Slow deliberate movement past the buffer: carry him.
        XCTAssertEqual(FlameGestureClassifier.dragIntent(
            elapsed: 0.20, magnitude: 24, velocity: 180), .carry)
        // Held touch that finally moves a little: carry, not flick.
        XCTAssertEqual(FlameGestureClassifier.dragIntent(
            elapsed: 0.42, magnitude: 16, velocity: 60), .carry)
        // Fast but tiny: not enough travel to call it yet.
        XCTAssertEqual(FlameGestureClassifier.dragIntent(
            elapsed: 0.03, magnitude: 9, velocity: 1400), .deciding)
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
        let count = FlameIdleAction.allCases.count
        let sequence = (0..<(count * 2)).map { _ in planner.next().action }
        // Every behavior appears once per bag, never twice in a row, and
        // not in the same fixed order every time (not on rails).
        for action in FlameIdleAction.allCases {
            XCTAssertEqual(sequence.filter { $0 == action }.count, 2, "\(action)")
        }
        for i in 1..<sequence.count {
            XCTAssertNotEqual(sequence[i], sequence[i - 1], "repeat at \(i)")
        }
        XCTAssertNotEqual(Array(sequence.prefix(count)),
                          Array(sequence.suffix(count)))
        XCTAssertGreaterThanOrEqual(count, 10)
    }

    func testFlickExpiresWhenTouchIsHeld() {
        // Still down well past the flick window: it was a fast drag.
        XCTAssertTrue(FlameGestureClassifier.flickExpires(elapsed: 0.30, velocity: 900))
        // Slowed right down while still touching: carry, don't fling.
        XCTAssertTrue(FlameGestureClassifier.flickExpires(elapsed: 0.20, velocity: 200))
        // Fresh and fast: flick still armed.
        XCTAssertFalse(FlameGestureClassifier.flickExpires(elapsed: 0.12, velocity: 900))
        XCTAssertFalse(FlameGestureClassifier.flickExpires(elapsed: 0.05, velocity: 100))
    }

    func testDoubleTapWindow() {
        XCTAssertTrue(FlameGestureClassifier.isDoubleTap(previousAt: 1.0, now: 1.25))
        XCTAssertFalse(FlameGestureClassifier.isDoubleTap(previousAt: 1.0, now: 1.60))
        XCTAssertFalse(FlameGestureClassifier.isDoubleTap(previousAt: nil, now: 1.0))
        XCTAssertFalse(FlameGestureClassifier.isDoubleTap(previousAt: 2.0, now: 1.0))
    }

    /// The user's Flame Lab picks (2026-11-03), baked as factory defaults.
    func testBakedDefaultsMatchLabPicks() {
        let s = FlameInteractionSettings()
        XCTAssertEqual(s.homeFlameSize, 122)
        XCTAssertEqual(s.liveliness, 1.35)
        XCTAssertEqual(s.jumpHeight, 24)
        XCTAssertEqual(s.gyroLeanDegrees, 14)
        XCTAssertEqual(s.idleInterval, 5)
        XCTAssertTrue(s.gyroEnabled)
        XCTAssertTrue(s.idleEnabled)
        let expected: [FlameGestureKind: FlameReactionKind] = [
            .tapHead: .pat, .tapBody: .poke, .tapFeet: .footTapDance,
            .doubleTap: .laugh, .longPress: .wave,
            .swipeUp: .bigJump, .swipeDown: .duck,
            .swipeLeft: .sideHop, .swipeRight: .sideHop,
            .pinchIn: .shrinkStartle, .pinchOut: .puffUp,
            .shake: .nauseous,
        ]
        XCTAssertEqual(s.reactions, expected)
    }

    func testDoubleTapAndLongPressDefaults() {
        let settings = FlameInteractionSettings()
        XCTAssertEqual(settings.reaction(for: .doubleTap), .laugh)
        XCTAssertEqual(settings.reaction(for: .longPress), .wave)
        XCTAssertFalse(FlameGestureKind.doubleTap.label.isEmpty)
        XCTAssertFalse(FlameGestureKind.longPress.label.isEmpty)
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
