import Foundation

public struct FlamePoint: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public init(x: Double = 0, y: Double = 0) { self.x = x; self.y = y }
    public static let zero = Self()
    public var length: Double { hypot(x, y) }
    public var isFinite: Bool { x.isFinite && y.isFinite }
    public static func + (a: Self, b: Self) -> Self { Self(x: a.x + b.x, y: a.y + b.y) }
    public static func - (a: Self, b: Self) -> Self { Self(x: a.x - b.x, y: a.y - b.y) }
    public static func * (a: Self, b: Double) -> Self { Self(x: a.x * b, y: a.y * b) }
    func limited(to limit: Double) -> Self { length > limit ? self * (limit / length) : self }
}

/// The approved touch model, in a size-independent 210pt reference rig.
/// A held point and a body mass share one spring. The body is rooted until
/// pickup, and stays rooted for a short release: only the stretch has inertia.
public struct FlameTouchPhysics: Sendable {
    public enum Phase: Sendable { case idle, stretching, carrying, recoiling, settling }
    public static let referenceSize = 210.0
    public static let pickupDelay = 0.18
    public private(set) var phase: Phase = .idle
    public private(set) var body = FlamePoint.zero
    public private(set) var bodyVelocity = FlamePoint.zero
    public private(set) var handle = FlamePoint.zero
    public private(set) var handleVelocity = FlamePoint.zero
    public private(set) var grab = FlamePoint.zero
    public private(set) var carryBlend = 0.0
    public private(set) var lean = 0.0
    public private(set) var joints = FlameTouchJoint.defaults
    public var isHeld: Bool { phase == .stretching || phase == .carrying }
    public var isActive: Bool { phase != .idle }
    public var stretch: FlamePoint {
        let value = (handle - body - grab).limited(to: 105)
        // Compression toward the rooted feet must not fold the texture.
        return value.y > 32 ? value * (32 / value.y) : value
    }
    public var travel: Double { translation.length }
    private var home = FlamePoint.zero
    private var target = FlamePoint.zero
    private var translation = FlamePoint.zero
    private var age = 0.0
    private var mayCarry = false
    private var reducedMotion = false
    private var leanVelocity = 0.0
    private var samples: [(point: FlamePoint, time: Double)] = []
    private var sampleTime = 0.0

    public init() {}

    public mutating func begin(at grab: FlamePoint, movable: Bool, reduceMotion: Bool = false) {
        guard grab.isFinite else { return }
        self.grab = grab
        mayCarry = movable
        reducedMotion = reduceMotion
        home = body
        target = body + grab
        translation = .zero
        handle = target
        handleVelocity = bodyVelocity
        carryBlend = 0
        age = 0
        sampleTime = 0
        samples = [(.zero, 0)]
        phase = .stretching
    }

    public mutating func move(to translation: FlamePoint, at time: Double) {
        guard isHeld, translation.isFinite, time.isFinite, time >= sampleTime else { return }
        self.translation = translation
        target = home + grab + translation
        samples.append((translation, time))
        samples.removeAll { time - $0.time > 0.16 }
        sampleTime = time
    }

    /// Returns a placement translation only for a confirmed carry. Short
    /// swipes keep the original home, including diagonal and tiny flicks.
    @discardableResult
    public mutating func release(at time: Double) -> FlamePoint? {
        guard isHeld else { return nil }
        if phase == .carrying {
            let committed = home + translation
            // Parent placement takes over the target in this same frame.
            // Keep the residual position/velocity so dropping cannot snap.
            body = body - committed
            handle = handle - committed
            home = .zero
            target = grab
            phase = .settling
            if reducedMotion { reset() }
            return committed
        }
        if travel > 5, !reducedMotion {
            phase = .recoiling
            let recent = samples.filter { time - $0.time <= 0.10 }
            if let first = recent.first, let last = recent.last,
               last.time - first.time >= 0.008, time - last.time < 0.07 {
                let velocity = ((last.point - first.point) * (1 / (last.time - first.time))).limited(to: 1250)
                handleVelocity = handleVelocity + velocity * 0.5
            }
        } else {
            phase = .settling
            if reducedMotion { reset() }
        }
        return nil
    }

    public mutating func cancel() { reset() }

    public mutating func advance(by elapsed: Double) {
        guard isActive, elapsed.isFinite, elapsed > 0 else { return }
        age += min(elapsed, 1)
        if phase == .stretching, mayCarry, age >= Self.pickupDelay, travel > 4 {
            phase = .carrying
        }
        if reducedMotion {
            body = phase == .carrying ? target - grab : home
            handle = body + grab
            bodyVelocity = .zero; handleVelocity = .zero
            return
        }
        // Bounded 240Hz substeps are independent of gesture event delivery.
        var remaining = min(elapsed, 0.05)
        while remaining > 0.000001 {
            let dt = min(remaining, 1.0 / 240)
            step(dt)
            remaining -= dt
        }
        if !isHeld, (body - home).length < 0.3,
           (handle - body - grab).length < 0.3,
           bodyVelocity.length + handleVelocity.length < 0.4,
           joints.allSatisfy({ abs($0.angle) + abs($0.velocity) < 0.02 }) {
            reset()
        }
    }

    private mutating func step(_ dt: Double) {
        let oldVelocity = bodyVelocity
        let carrying = phase == .carrying
        let blend = carrying ? min(1, max(0, (age - Self.pickupDelay) / 0.085)) : 0
        let soft = blend * blend * (3 - 2 * blend)
        let recoiling = phase == .recoiling
        let k = recoiling ? 180 * 0.35 : 180
        let damping = recoiling ? 8 * 0.8 : 8
        let force = (handle - body - grab) * k + (handleVelocity - bodyVelocity) * damping
        var handleForce = force * -1
        if isHeld {
            let desired = body + grab + (target - body - grab).limited(to: 100 + soft * 40)
            handleForce = handleForce + (desired - handle) * 4500 - handleVelocity * 40
        }
        let anchorK = isHeld ? 3200 * (1 - soft) : recoiling ? 3200 : 35
        let anchorDamping = isHeld ? 80 * (1 - soft) + 2 : recoiling ? 80 : 8
        bodyVelocity = bodyVelocity + (force + (home - body) * anchorK - bodyVelocity * anchorDamping) * dt
        handleVelocity = handleVelocity + handleForce * (dt / (recoiling ? 1.3 : 0.18))
        body = body + bodyVelocity * dt
        handle = handle + handleVelocity * dt
        carryBlend += ((carrying || phase == .settling ? 1.0 : 0) - carryBlend) * min(1, dt * 15)
        let acceleration = ((bodyVelocity - oldVelocity) * (1 / dt)).limited(to: 3500)
        let leanTarget = min(0.15, max(-0.15, -bodyVelocity.x * 0.00042)) * carryBlend
        leanVelocity += (72 * (leanTarget - lean) - 10 * leanVelocity) * dt
        lean += leanVelocity * dt
        for i in joints.indices {
            joints[i].step(acceleration: acceleration, held: carrying, dt: dt)
        }
    }

    private mutating func reset() {
        self = Self()
    }

    /// Forward deformation shared by the renderer and joint attachments.
    /// Input/output are in full-rig reference coordinates, before body offset.
    public func displacement(at point: FlamePoint) -> FlamePoint {
        let local = point - FlamePoint(x: 106.75, y: 134.1666667)
        let distance = (local - grab).length
        let lower = min(1, max(0, ((point.y / 262.5 - 0.2) / (560.0 / 900) - 0.48) / 0.42))
        let rooted = 1 - lower * lower * (3 - 2 * lower)
        let weight = exp(-distance * distance / (2 * 65 * 65))
            * (1 - 0.84 * carryBlend) * (rooted + (1 - rooted) * carryBlend)
        return stretch * weight
    }
}

/// Distinct angular springs let limbs trail acceleration and settle even
/// when the finger has stopped sending move events. Laptop hands have
/// tighter limits; the solid laptop never gets stretched with the torso.
public struct FlameTouchJoint: Sendable {
    public private(set) var angle = 0.0
    public private(set) var velocity = 0.0
    private var stiffness: Double
    private var damping: Double
    private var length: Double
    private var rest: Double
    private var limit: Double

    static var defaults: [Self] { [
        Self(stiffness: 62, damping: 4, length: 29, rest: 0.05, limit: 1.05),
        Self(stiffness: 78, damping: 4.7, length: 33, rest: -0.05, limit: 1.05),
        Self(stiffness: 43, damping: 3.1, length: 38, rest: 0.22, limit: 1.4),
        Self(stiffness: 53, damping: 3.6, length: 41, rest: -0.22, limit: 1.4),
        Self(stiffness: 110, damping: 8, length: 49, rest: 0, limit: 0.22),
        Self(stiffness: 124, damping: 9, length: 48, rest: 0, limit: 0.22),
        Self(stiffness: 95, damping: 7, length: 70, rest: 0, limit: 0.16)
    ] }

    mutating func step(acceleration: FlamePoint, held: Bool, dt: Double) {
        let drive = (acceleration.x * cos(angle) + acceleration.y * sin(angle)) / length
        velocity += (stiffness * ((held ? rest : 0) - angle) - damping * velocity + drive * 0.92) * dt
        angle += velocity * dt
        if abs(angle) > limit {
            angle = min(limit, max(-limit, angle))
            velocity *= 0.35
        }
    }
}
