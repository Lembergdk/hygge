import Foundation

/// A normalized tilt signal for the flame, independent of any sensor or
/// gesture framework. Both axes are clamped to -1...1: x is roll
/// (positive = device/finger toward the right) and y is pitch
/// (positive = top of the device tipping away/down-screen).
public struct FlameTilt: Equatable, Sendable {
    public var x: Double
    public var y: Double

    public init(x: Double = 0, y: Double = 0) {
        self.x = Self.clamp(x)
        self.y = Self.clamp(y)
    }

    public static let zero = FlameTilt()

    static func clamp(_ value: Double) -> Double {
        guard value.isFinite else { return 0 }
        return min(1, max(-1, value))
    }
}

public enum FlameTiltMapper {
    /// Maps device-motion gravity to tilt relative to a captured neutral
    /// pose, with a small deadzone so hand tremor does not jitter him.
    public static func deviceTilt(gravityX: Double, gravityY: Double,
                                  neutralX: Double, neutralY: Double) -> FlameTilt {
        FlameTilt(x: differential(gravityX - neutralX),
                  y: differential(gravityY - neutralY))
    }

    /// Dragging a finger across the flame is the fallback tilt source on
    /// devices and simulators without motion sensors.
    public static func pointerTilt(translationX: Double, translationY: Double,
                                   width: Double, height: Double) -> FlameTilt {
        guard width > 0, height > 0 else { return .zero }
        return FlameTilt(x: translationX / (width * 0.55),
                         y: translationY / (height * 0.55))
    }

    private static func differential(_ delta: Double) -> Double {
        let deadzone = 0.03
        guard delta.isFinite else { return 0 }
        let magnitude = max(0, abs(delta) - deadzone) / (1 - deadzone)
        return (delta < 0 ? -1 : 1) * magnitude * 2.2
    }
}

/// A tiny spring so tilt (and the flame following it) settles with a
/// little overshoot instead of snapping or lagging linearly. Defaults are
/// deliberately under-damped: he should feel alive, not damped to sleep.
public struct FlameSpring: Equatable, Sendable {
    public private(set) var value: FlameTilt
    public private(set) var velocityX: Double
    public private(set) var velocityY: Double
    public var stiffness: Double
    public var damping: Double

    public init(value: FlameTilt = .zero, stiffness: Double = 95, damping: Double = 11) {
        self.value = value
        self.velocityX = 0
        self.velocityY = 0
        self.stiffness = stiffness
        self.damping = damping
    }

    public mutating func step(toward target: FlameTilt, deltaTime: Double) {
        guard deltaTime.isFinite, deltaTime > 0 else { return }
        let dt = min(deltaTime, 0.05)
        velocityX += (stiffness * (target.x - value.x) - damping * velocityX) * dt
        velocityY += (stiffness * (target.y - value.y) - damping * velocityY) * dt
        value = FlameTilt(x: value.x + velocityX * dt,
                          y: value.y + velocityY * dt)
    }

    public mutating func reset() {
        value = .zero
        velocityX = 0
        velocityY = 0
    }
}
