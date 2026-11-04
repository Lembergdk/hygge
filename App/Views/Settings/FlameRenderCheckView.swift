#if DEBUG
import SwiftUI

/// Offline visual fixtures for the real renderer and physics, including
/// the padded stretch shader and independent laptop/limb attachments.
/// Launch: --settings-preview --flame-render-check
struct FlameRenderCheckView: View {
    var body: some View {
        VStack(spacing: 8) {
            Text("Flame interaction check").font(.headline)
            ForEach(["At rest", "Flick stretch", "Carried"], id: \.self) { name in
                VStack(spacing: 0) {
                    Text(name).font(.caption)
                    HStack(spacing: 16) {
                        character(name, laptop: false)
                        character(name, laptop: true)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(HyggeTheme.paper)
    }

    private func character(_ name: String, laptop: Bool) -> some View {
        let physics = sample(name)
        return RiggedFlame(pose: .rest, size: 150, laptop: laptop, touch: physics)
            .frame(width: 160, height: 190)
    }

    private func sample(_ name: String) -> FlameTouchPhysics {
        var physics = FlameTouchPhysics()
        guard name != "At rest" else { return physics }
        physics.begin(at: FlamePoint(y: -20), movable: true)
        for i in 1...6 {
            physics.move(to: FlamePoint(x: Double(i) * 10, y: Double(i) * -4),
                         at: Double(i) / 60)
            physics.advance(by: 1.0 / 60)
        }
        if name == "Flick stretch" {
            physics.release(at: 0.1)
            for _ in 0..<5 { physics.advance(by: 1.0 / 60) }
        } else {
            for _ in 0..<17 { physics.advance(by: 1.0 / 60) }
            physics.move(to: FlamePoint(x: -60, y: -30), at: 0.4)
            for _ in 0..<5 { physics.advance(by: 1.0 / 60) }
        }
        return physics
    }
}

#Preview { FlameRenderCheckView() }
#endif
