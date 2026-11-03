import CoreMotion
import Foundation
import Observation

/// Feeds the flame a smoothed device tilt plus shake events. The first
/// samples after each start become the neutral pose, so however the phone
/// is being held when he appears reads as "level". Unavailable on
/// Simulator — callers fall back to drag-driven tilt and he simply stays
/// upright until a finger pushes him.
@Observable
@MainActor
final class FlameMotionService {
    private(set) var tilt: FlameTilt = .zero
    private(set) var isSensorAvailable = false
    /// Increments once per detected shake (cooldown inside the detector).
    private(set) var shakeCount = 0

    private let manager = CMMotionManager()
    private var spring = FlameSpring()
    private var shakeDetector = FlameShakeDetector()
    private var neutralSamples: [(x: Double, y: Double)] = []
    private var neutral: (x: Double, y: Double)?
    private var lastTimestamp: TimeInterval?

    func start() {
        guard !manager.isDeviceMotionActive else { return }
        isSensorAvailable = manager.isDeviceMotionAvailable
        guard isSensorAvailable else { return }
        neutral = nil
        neutralSamples.removeAll()
        lastTimestamp = nil
        spring.reset()
        tilt = .zero
        manager.deviceMotionUpdateInterval = 1.0 / 30.0
        manager.startDeviceMotionUpdates(to: .main) { [weak self] motion, _ in
            guard let self, let motion else { return }
            MainActor.assumeIsolated { self.consume(motion) }
        }
    }

    func stop() {
        if manager.isDeviceMotionActive {
            manager.stopDeviceMotionUpdates()
        }
        spring.reset()
        tilt = .zero
        lastTimestamp = nil
    }

    private func consume(_ motion: CMDeviceMotion) {
        let accel = motion.userAcceleration
        if shakeDetector.consume(x: accel.x, y: accel.y, z: accel.z,
                                 at: motion.timestamp) {
            shakeCount += 1
        }
        let gravity = motion.gravity
        guard let neutral else {
            neutralSamples.append((gravity.x, gravity.y))
            if neutralSamples.count >= 12 {
                let n = Double(neutralSamples.count)
                self.neutral = (neutralSamples.reduce(0) { $0 + $1.x } / n,
                                neutralSamples.reduce(0) { $0 + $1.y } / n)
                lastTimestamp = motion.timestamp
            }
            return
        }
        let dt = lastTimestamp.map { motion.timestamp - $0 } ?? (1.0 / 30.0)
        lastTimestamp = motion.timestamp
        let target = FlameTiltMapper.deviceTilt(
            gravityX: gravity.x, gravityY: gravity.y,
            neutralX: neutral.x, neutralY: neutral.y)
        spring.step(toward: target, deltaTime: dt)
        tilt = spring.value
    }
}
