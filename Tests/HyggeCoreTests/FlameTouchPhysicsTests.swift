import XCTest
@testable import HyggeCore

final class FlameTouchPhysicsTests: XCTestCase {
    private let dt = 1.0 / 60

    private func flick(_ direction: FlamePoint = FlamePoint(x: 1)) -> FlameTouchPhysics {
        var physics = FlameTouchPhysics()
        physics.begin(at: FlamePoint(y: -20), movable: true)
        for i in 1...6 {
            physics.move(to: direction * (Double(i) * 10), at: Double(i) * dt)
            physics.advance(by: dt)
        }
        XCTAssertNil(physics.release(at: 0.1))
        return physics
    }

    func testImmediateStretchBeforePickup() {
        var p = FlameTouchPhysics()
        p.begin(at: .zero, movable: true)
        p.move(to: FlamePoint(x: 60), at: 0.04)
        p.advance(by: 0.04)
        XCTAssertEqual(p.phase, .stretching)
        XCTAssertGreaterThan(p.stretch.x, 40)
        XCTAssertLessThan(p.body.length, 5)
    }

    func testFlickContinuesStretchingWhileBodyStaysRootedThenSettles() {
        // Every direction, including diagonal and compression toward feet.
        for direction in [FlamePoint(x: 1), FlamePoint(x: -1), FlamePoint(y: -1),
                          FlamePoint(y: 1), FlamePoint(x: 0.7, y: -0.7)] {
            var p = flick(direction)
            XCTAssertEqual(p.phase, .recoiling)
            let initialStretch = (p.handle - p.body - p.grab).length
            var peak = initialStretch
            var bodyPeak = p.body.length
            for _ in 0..<180 {
                p.advance(by: dt)
                peak = max(peak, (p.handle - p.body - p.grab).length)
                bodyPeak = max(bodyPeak, p.body.length)
            }
            XCTAssertGreaterThan(peak, initialStretch + 10)
            XCTAssertLessThan(bodyPeak, 8)
            XCTAssertLessThan(p.stretch.length, 0.5)
            XCTAssertLessThan(p.body.length, 0.5)
        }
    }

    func testStationaryFingerPicksUpAfterDelayAndContinuesSpringing() {
        var p = FlameTouchPhysics()
        p.begin(at: .zero, movable: true)
        p.move(to: FlamePoint(x: 80), at: 0.04)
        for _ in 0..<10 { p.advance(by: dt) }
        XCTAssertEqual(p.phase, .stretching)
        for _ in 0..<30 { p.advance(by: dt) }
        XCTAssertEqual(p.phase, .carrying)
        XCTAssertGreaterThan(p.body.x, 60)
        XCTAssertGreaterThan(p.carryBlend, 0.9)
    }

    func testDropCommitsOnlyCarriedTargetWithoutDiscontinuity() throws {
        var p = FlameTouchPhysics()
        p.begin(at: .zero, movable: true)
        p.move(to: FlamePoint(x: 130, y: -40), at: 0.04)
        for _ in 0..<25 { p.advance(by: dt) }
        let before = p.body
        let committed = try XCTUnwrap(p.release(at: 0.5))
        XCTAssertEqual(committed, FlamePoint(x: 130, y: -40))
        XCTAssertEqual(p.body.x + committed.x, before.x, accuracy: 0.00001)
        XCTAssertEqual(p.body.y + committed.y, before.y, accuracy: 0.00001)
        for _ in 0..<240 { p.advance(by: dt) }
        XCTAssertLessThan(p.body.length, 0.1)
    }

    func testIndependentLimbsContinueSettlingWithoutGestureEvents() {
        var p = FlameTouchPhysics()
        p.begin(at: .zero, movable: true)
        p.move(to: FlamePoint(x: 100), at: 0.1)
        for _ in 0..<25 { p.advance(by: dt) }
        XCTAssertNotEqual(p.joints[2].angle, p.joints[3].angle)
        let first = p.joints.map(\.angle)
        for _ in 0..<12 { p.advance(by: dt) }
        XCTAssertNotEqual(first, p.joints.map(\.angle))
        XCTAssertLessThanOrEqual(abs(p.joints[4].angle), 0.22)
        XCTAssertLessThanOrEqual(abs(p.joints[6].angle), 0.16)
    }

    func testFeetStayRootedAndCompressionCannotFoldTexture() {
        var p = flick(FlamePoint(y: 1))
        p.advance(by: 0.05)
        XCTAssertEqual(p.displacement(at: FlamePoint(x: 105, y: 230)), .zero)
        XCTAssertLessThanOrEqual(p.stretch.y, 32)
    }

    func testDeformationDoesNotFoldAtStrongFlickPeaks() {
        for direction in [FlamePoint(x: 1), FlamePoint(y: 1), FlamePoint(y: -1),
                          FlamePoint(x: 0.95, y: 0.31)] {
            var p = flick(direction)
            for _ in 0..<6 { p.advance(by: dt) }
            for y in stride(from: 55.0, through: 215, by: 8) {
                for x in stride(from: 45.0, through: 170, by: 8) {
                    let point = FlamePoint(x: x, y: y)
                    let d = p.displacement(at: point)
                    let dx = p.displacement(at: point + FlamePoint(x: 0.01)) - d
                    let dy = p.displacement(at: point + FlamePoint(y: 0.01)) - d
                    let determinant = (1 + dx.x / 0.01) * (1 + dy.y / 0.01)
                        - dx.y * dy.x / 0.0001
                    XCTAssertGreaterThan(determinant, 0.02)
                }
            }
        }
    }

    func testNonmovableAvatarNeverCommitsPlacement() {
        var p = FlameTouchPhysics()
        p.begin(at: .zero, movable: false)
        p.move(to: FlamePoint(x: 80), at: 0.1)
        for _ in 0..<60 { p.advance(by: dt) }
        XCTAssertEqual(p.phase, .stretching)
        XCTAssertNil(p.release(at: 1))
    }

    func testReducedMotionCarriesWithoutRecoilAndCancellationResets() {
        var p = FlameTouchPhysics()
        p.begin(at: .zero, movable: true, reduceMotion: true)
        p.move(to: FlamePoint(x: 100), at: 0.05)
        p.advance(by: 0.05)
        XCTAssertEqual(p.body, .zero)
        XCTAssertEqual(p.stretch, .zero)
        for _ in 0..<15 { p.advance(by: dt) }
        XCTAssertEqual(p.body.x, 100)
        XCTAssertEqual(p.release(at: 0.3), FlamePoint(x: 100))
        XCTAssertFalse(p.isActive)
        p.begin(at: .zero, movable: true)
        p.move(to: FlamePoint(x: 80), at: 0.1)
        p.advance(by: 0.05)
        p.cancel()
        XCTAssertFalse(p.isHeld)
        XCTAssertFalse(p.isActive)
        XCTAssertEqual(p.stretch, .zero)
    }

    func testStalledFramesAndInvalidInputStayFinite() {
        var p = flick()
        for _ in 0..<20 { p.advance(by: 2) }
        p.advance(by: .infinity)
        p.move(to: FlamePoint(x: .nan), at: 3)
        XCTAssertTrue(p.body.isFinite)
        XCTAssertTrue(p.handle.isFinite)
        XCTAssertTrue(p.joints.allSatisfy { $0.angle.isFinite })
    }
}
