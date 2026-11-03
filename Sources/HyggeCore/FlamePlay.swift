import Foundation

/// The explorable gesture vocabulary the flame understands. Lab users can
/// remap every one of these to any reaction below.
public enum FlameGestureKind: String, CaseIterable, Codable, Equatable, Sendable, Identifiable {
    case tapHead, tapBody, tapFeet
    case swipeUp, swipeDown, swipeLeft, swipeRight
    case pinchIn, pinchOut
    case shake

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .tapHead: return "Tap his head"
        case .tapBody: return "Tap his body"
        case .tapFeet: return "Tap his feet"
        case .swipeUp: return "Flick up"
        case .swipeDown: return "Flick down"
        case .swipeLeft: return "Flick left"
        case .swipeRight: return "Flick right"
        case .pinchIn: return "Pinch in"
        case .pinchOut: return "Pinch out"
        case .shake: return "Shake the phone"
        }
    }
}

/// What he does back. Directional reactions (side hop, poke) borrow their
/// direction from the gesture that triggered them.
public enum FlameReactionKind: String, CaseIterable, Codable, Equatable, Sendable, Identifiable {
    case none, pat, poke, footTapDance, miniHop, bigJump, duck, sideHop
    case twirl, wiggle, stretch, puffUp, shrinkStartle, dizzy
    case wave, pointUp, laugh, cry, nauseous, turnAround, walkAbout

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .none: return "Nothing"
        case .pat: return "Happy pat squash"
        case .poke: return "Poke recoil"
        case .footTapDance: return "Foot-tap dance"
        case .miniHop: return "Mini hop"
        case .bigJump: return "Big jump, arms up"
        case .duck: return "Duck down"
        case .sideHop: return "Side hop"
        case .twirl: return "Twirl"
        case .wiggle: return "Excited wiggle"
        case .stretch: return "Big stretch"
        case .puffUp: return "Puff up proud"
        case .shrinkStartle: return "Shrink & startle"
        case .dizzy: return "Dizzy wobble"
        case .wave: return "Wave hello"
        case .pointUp: return "Point up excitedly"
        case .laugh: return "Laugh"
        case .cry: return "Cry"
        case .nauseous: return "Feel sick"
        case .turnAround: return "Turn his back & spin"
        case .walkAbout: return "Walk on the spot"
        }
    }
}

public enum FlameSwipe: Equatable, Sendable {
    case left, right, up, down
}

public enum FlameGestureClassifier {
    /// Classifies a finished drag from its predicted end translation, so
    /// quick flicks count even when the finger travelled a short way.
    public static func swipe(predictedX: Double, predictedY: Double,
                             threshold: Double = 70) -> FlameSwipe? {
        guard predictedX.isFinite, predictedY.isFinite else { return nil }
        let ax = abs(predictedX)
        let ay = abs(predictedY)
        guard max(ax, ay) >= threshold else { return nil }
        if ax >= ay * 1.35 { return predictedX < 0 ? .left : .right }
        if ay >= ax * 1.35 { return predictedY < 0 ? .up : .down }
        return nil
    }

    /// Was a drag released as a flick? A flick's predicted end flies far
    /// beyond where the finger actually stopped (release velocity), while
    /// a carried drag's prediction barely overshoots its travel — so a
    /// movable flame can tell "put me here" from "fling and react".
    public static func isFlickRelease(translationX: Double, translationY: Double,
                                      predictedX: Double, predictedY: Double) -> Bool {
        guard swipe(predictedX: predictedX, predictedY: predictedY) != nil else { return false }
        let travelled = hypot(translationX, translationY)
        let predicted = hypot(predictedX, predictedY)
        return predicted - travelled >= 80
    }

    /// Full gesture classification for a finished touch on the flame.
    /// Swipes win; otherwise a short touch is a tap in the zone it landed
    /// (`tapNormalizedY` is 0 at the flame's top, 1 at his feet).
    public static func classify(translationX: Double, translationY: Double,
                                predictedX: Double, predictedY: Double,
                                tapNormalizedY: Double) -> FlameGestureKind? {
        if let swipe = swipe(predictedX: predictedX, predictedY: predictedY) {
            switch swipe {
            case .left: return .swipeLeft
            case .right: return .swipeRight
            case .up: return .swipeUp
            case .down: return .swipeDown
            }
        }
        guard hypot(translationX, translationY) < 12 else { return nil }
        let y = min(1, max(0, tapNormalizedY))
        if y < 0.34 { return .tapHead }
        if y > 0.78 { return .tapFeet }
        return .tapBody
    }
}

/// Where the user dropped him on the Home feed, as a normalized center
/// (0...1 in the feed's width/height). `nil` = his home corner.
public struct FlamePlacement: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x.isFinite ? min(1, max(0, x)) : 1
        self.y = y.isFinite ? min(1, max(0, y)) : 1
    }
}

/// Everything the Flame Lab can tune, persisted as one value. Defaults are
/// what ships: a 122pt Home flame with springy, varied reactions.
public struct FlameInteractionSettings: Codable, Equatable, Sendable {
    public var homeFlameSize: Double
    public var liveliness: Double
    public var gyroLeanDegrees: Double
    public var jumpHeight: Double
    public var idleInterval: Double
    public var idleEnabled: Bool
    public var gyroEnabled: Bool
    public var reactions: [FlameGestureKind: FlameReactionKind]
    /// The user's own words for what each gesture should do. Saved with
    /// the picks today; they become generated behaviors once the backend
    /// description-to-behavior route lands.
    public var descriptions: [FlameGestureKind: String]
    public var placement: FlamePlacement?

    public init(homeFlameSize: Double = 122, liveliness: Double = 1.35,
                gyroLeanDegrees: Double = 9, jumpHeight: Double = 24,
                idleInterval: Double = 5, idleEnabled: Bool = true,
                gyroEnabled: Bool = true,
                reactions: [FlameGestureKind: FlameReactionKind]? = nil,
                descriptions: [FlameGestureKind: String] = [:],
                placement: FlamePlacement? = nil) {
        self.homeFlameSize = homeFlameSize
        self.liveliness = liveliness
        self.gyroLeanDegrees = gyroLeanDegrees
        self.jumpHeight = jumpHeight
        self.idleInterval = idleInterval
        self.idleEnabled = idleEnabled
        self.gyroEnabled = gyroEnabled
        self.reactions = reactions ?? Self.defaultReactions
        self.descriptions = descriptions
        self.placement = placement
        clamp()
    }

    public static let defaultReactions: [FlameGestureKind: FlameReactionKind] = [
        .tapHead: .pat, .tapBody: .poke, .tapFeet: .footTapDance,
        .swipeUp: .bigJump, .swipeDown: .duck,
        .swipeLeft: .sideHop, .swipeRight: .sideHop,
        .pinchIn: .shrinkStartle, .pinchOut: .puffUp,
        .shake: .nauseous,
    ]

    public func reaction(for gesture: FlameGestureKind) -> FlameReactionKind {
        reactions[gesture] ?? Self.defaultReactions[gesture] ?? .none
    }

    public mutating func setReaction(_ reaction: FlameReactionKind,
                                     for gesture: FlameGestureKind) {
        reactions[gesture] = reaction
    }

    public func description(for gesture: FlameGestureKind) -> String {
        descriptions[gesture] ?? ""
    }

    public mutating func setDescription(_ text: String, for gesture: FlameGestureKind) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { descriptions[gesture] = nil }
        else { descriptions[gesture] = text }
    }

    public mutating func clamp() {
        homeFlameSize = Self.clamp(homeFlameSize, 81, 170, fallback: 122)
        liveliness = Self.clamp(liveliness, 0.4, 2, fallback: 1.35)
        gyroLeanDegrees = Self.clamp(gyroLeanDegrees, 0, 14, fallback: 9)
        jumpHeight = Self.clamp(jumpHeight, 8, 40, fallback: 24)
        idleInterval = Self.clamp(idleInterval, 2.5, 10, fallback: 5)
        if let p = placement { placement = FlamePlacement(x: p.x, y: p.y) }
    }

    private static func clamp(_ v: Double, _ lo: Double, _ hi: Double,
                              fallback: Double) -> Double {
        v.isFinite ? min(hi, max(lo, v)) : fallback
    }

    private enum CodingKeys: String, CodingKey {
        case homeFlameSize, liveliness, gyroLeanDegrees, jumpHeight
        case idleInterval, idleEnabled, gyroEnabled, reactions
        case descriptions, placement
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = FlameInteractionSettings()
        homeFlameSize = try c.decodeIfPresent(Double.self, forKey: .homeFlameSize) ?? d.homeFlameSize
        liveliness = try c.decodeIfPresent(Double.self, forKey: .liveliness) ?? d.liveliness
        gyroLeanDegrees = try c.decodeIfPresent(Double.self, forKey: .gyroLeanDegrees) ?? d.gyroLeanDegrees
        jumpHeight = try c.decodeIfPresent(Double.self, forKey: .jumpHeight) ?? d.jumpHeight
        idleInterval = try c.decodeIfPresent(Double.self, forKey: .idleInterval) ?? d.idleInterval
        idleEnabled = try c.decodeIfPresent(Bool.self, forKey: .idleEnabled) ?? d.idleEnabled
        gyroEnabled = try c.decodeIfPresent(Bool.self, forKey: .gyroEnabled) ?? d.gyroEnabled
        let raw = try c.decodeIfPresent([String: FlameReactionKind].self, forKey: .reactions) ?? [:]
        var merged = Self.defaultReactions
        for (key, value) in raw {
            if let gesture = FlameGestureKind(rawValue: key) { merged[gesture] = value }
        }
        reactions = merged
        let rawDescriptions = try c.decodeIfPresent([String: String].self, forKey: .descriptions) ?? [:]
        descriptions = Dictionary(uniqueKeysWithValues: rawDescriptions.compactMap { key, value in
            FlameGestureKind(rawValue: key).map { ($0, value) }
        })
        placement = try c.decodeIfPresent(FlamePlacement.self, forKey: .placement)
        clamp()
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(homeFlameSize, forKey: .homeFlameSize)
        try c.encode(liveliness, forKey: .liveliness)
        try c.encode(gyroLeanDegrees, forKey: .gyroLeanDegrees)
        try c.encode(jumpHeight, forKey: .jumpHeight)
        try c.encode(idleInterval, forKey: .idleInterval)
        try c.encode(idleEnabled, forKey: .idleEnabled)
        try c.encode(gyroEnabled, forKey: .gyroEnabled)
        try c.encode(Dictionary(uniqueKeysWithValues: reactions.map { ($0.key.rawValue, $0.value) }),
                     forKey: .reactions)
        try c.encode(Dictionary(uniqueKeysWithValues: descriptions.map { ($0.key.rawValue, $0.value) }),
                     forKey: .descriptions)
        try c.encodeIfPresent(placement, forKey: .placement)
    }
}

public enum FlameIdleAction: String, CaseIterable, Equatable, Sendable {
    case lookLeft, footTap, lookRight, stretch, miniHop, wiggle
}

public struct FlameIdleStep: Equatable, Sendable {
    public var action: FlameIdleAction
    public var delayFactor: Double
}

/// Cycles idle behaviors so a quiet stretch never looks on rails: every
/// action appears once per cycle, at a slightly different spacing.
public struct FlameIdlePlanner: Equatable, Sendable {
    private var index = 0
    private let steps: [FlameIdleStep] = [
        .init(action: .lookLeft, delayFactor: 0.85),
        .init(action: .footTap, delayFactor: 1.15),
        .init(action: .lookRight, delayFactor: 0.7),
        .init(action: .stretch, delayFactor: 1.3),
        .init(action: .miniHop, delayFactor: 1.0),
        .init(action: .wiggle, delayFactor: 0.9),
    ]

    public init() {}

    public mutating func next() -> FlameIdleStep {
        defer { index = (index + 1) % steps.count }
        return steps[index]
    }
}

/// Detects a deliberate phone shake from user-acceleration samples (in g),
/// with a cooldown so one shake is one reaction.
public struct FlameShakeDetector: Equatable, Sendable {
    public var threshold: Double
    public var cooldown: Double
    private var lastTrigger: Double = -.infinity

    public init(threshold: Double = 1.55, cooldown: Double = 0.9) {
        self.threshold = threshold
        self.cooldown = cooldown
    }

    public mutating func consume(x: Double, y: Double, z: Double, at time: Double) -> Bool {
        let magnitude = (x * x + y * y + z * z).squareRoot()
        guard magnitude.isFinite, magnitude >= threshold,
              time - lastTrigger >= cooldown else { return false }
        lastTrigger = time
        return true
    }
}
