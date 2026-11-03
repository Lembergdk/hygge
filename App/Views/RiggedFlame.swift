import SwiftUI
import UIKit

/// Face variants rendered from the same Blender character
/// (hygge-flame-animation/build_parts.py), swapped as whole layers.
enum FlameFaceKind: String {
    case normal, happy, laugh, cry, sick, dizzy, surprised, sleepy

    var asset: String { "FlameRigFace" + rawValue.capitalized }
}

/// One pose of the layered rig. Angles are rotationEffect degrees:
/// for the screen-left arm, positive swings it out to the left/up;
/// for the screen-right arm, negative swings it out to the right/up.
struct FlamePose: Equatable {
    var dx: CGFloat = 0
    var dy: CGFloat = 0
    var sx: CGFloat = 1
    var sy: CGFloat = 1
    var rot: Double = 0
    var flipX: CGFloat = 1
    var armSL: Double = 0
    var armSR: Double = 0
    var legSL: Double = 0
    var legSR: Double = 0
    var face: FlameFaceKind = .normal
    var faceDX: CGFloat = 0
    var sickTint: Double = 0
    var backTurned = false

    static let rest = FlamePose()
}

/// The flame as registered layers (all 720×900, same framing): legs, body,
/// arms and face stack and move independently — wave, point, laugh, cry —
/// over a soft ground shadow that stays put when he jumps.
struct RiggedFlame: View {
    var pose: FlamePose
    var size: CGFloat
    var walking = false
    var clipOverride: FlameAnimation? = nil

    @Environment(\.scenePhase) private var scenePhase

    private static var cache: [String: UIImage] = [:]
    static func image(_ name: String) -> UIImage? {
        if let cached = cache[name] { return cached }
        guard let url = Bundle.main.url(forResource: name, withExtension: "png"),
              let img = UIImage(contentsOfFile: url.path) else { return nil }
        cache[name] = img
        return img
    }

    private func layer(_ name: String) -> some View {
        Group {
            if let img = Self.image(name) {
                Image(uiImage: img).resizable().scaledToFit()
            }
        }
        .frame(width: size, height: size * 1.25)
        .accessibilityHidden(true)
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 0.04,
                                paused: !walking || scenePhase != .active)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            let swing = walking ? sin(t * 7.5) : 0
            let bob: CGFloat = walking ? -abs(cos(t * 7.5)) * size * 0.018 : 0
            ZStack {
                groundShadow
                if let clipOverride {
                    AnimatedFlame(animation: clipOverride, size: size)
                        .shadow(color: .black.opacity(0.22), radius: 12, y: 6)
                        .offset(x: pose.dx, y: pose.dy + bob)
                        .scaleEffect(x: pose.sx * pose.flipX, y: pose.sy, anchor: .bottom)
                        .rotationEffect(.degrees(pose.rot), anchor: .bottom)
                } else {
                    rig(swing: swing, bob: bob)
                }
            }
            .frame(width: size, height: size * 1.25)
        }
        .frame(width: size, height: size * 1.25)
    }

    private var groundShadow: some View {
        // Stays on the ground: higher jump (more negative dy) = smaller,
        // fainter shadow, so height reads at a glance.
        let lift = min(1, max(0, -pose.dy / (size * 0.35)))
        return Ellipse()
            .fill(Color.black.opacity(0.26 - 0.13 * lift))
            .frame(width: size * (0.62 - 0.20 * lift), height: size * 0.10)
            .blur(radius: 6)
            // Feet end at ~81.5% of the canvas height.
            .offset(y: size * 0.40)
    }

    private func rig(swing: Double, bob: CGFloat) -> some View {
        ZStack {
            layer("FlameRigLegScreenLeft")
                .rotationEffect(.degrees(pose.legSL + swing * 26),
                                anchor: UnitPoint(x: 0.396, y: 0.656))
            layer("FlameRigLegScreenRight")
                .rotationEffect(.degrees(pose.legSR - swing * 26),
                                anchor: UnitPoint(x: 0.571, y: 0.656))
            layer("FlameRigBody")
                .shadow(color: .black.opacity(0.22), radius: 12, y: 6)
                .overlay {
                    if pose.sickTint > 0 {
                        layer("FlameRigBody")
                            .colorMultiply(Color(red: 0.75, green: 0.95, blue: 0.62))
                            .opacity(pose.sickTint)
                    }
                }
            layer("FlameRigArmScreenLeft")
                .rotationEffect(.degrees(pose.armSL - swing * 16),
                                anchor: UnitPoint(x: 0.254, y: 0.559))
            layer("FlameRigArmScreenRight")
                .rotationEffect(.degrees(pose.armSR + swing * 16),
                                anchor: UnitPoint(x: 0.728, y: 0.559))
            if !pose.backTurned {
                layer(pose.face.asset)
                    .offset(x: pose.faceDX)
                    .transition(.opacity)
            }
        }
        .offset(x: pose.dx, y: pose.dy + bob)
        .scaleEffect(x: pose.sx * pose.flipX, y: pose.sy, anchor: .bottom)
        .rotationEffect(.degrees(pose.rot), anchor: .bottom)
    }
}
