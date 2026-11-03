import Foundation
import Observation

/// The live, persisted copy of every Flame Lab knob. One instance is
/// injected at the app root; the Home flame, intro flame and Lab all read
/// the same settings, so a slider moved in the Lab is felt everywhere
/// immediately. Stored on-device only (UserDefaults) — it is a design
/// tool, never synced and never treated as a belief about the user.
@Observable
@MainActor
final class FlamePlayStore {
    static let storageKey = "flamePlay.settings.v1"

    var settings: FlameInteractionSettings {
        didSet { persist() }
    }

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.storageKey),
           let decoded = try? JSONDecoder().decode(FlameInteractionSettings.self, from: data) {
            var clamped = decoded
            clamped.clamp()
            settings = clamped
        } else {
            settings = FlameInteractionSettings()
        }
    }

    func reset() {
        settings = FlameInteractionSettings()
    }

    /// What "Copy my picks" hands back: a plain summary a person can read,
    /// followed by the exact JSON so the choices can be baked in verbatim.
    var exportText: String {
        let s = settings
        var lines = [
            "Flame Lab picks",
            "Size \(Int(s.homeFlameSize)) pt · Liveliness \(String(format: "%.2f", s.liveliness))× · Jump \(Int(s.jumpHeight)) pt",
            "Gyro lean \(s.gyroEnabled ? "\(Int(s.gyroLeanDegrees))°" : "off") · Idle \(s.idleEnabled ? "every ~\(String(format: "%.1f", s.idleInterval)) s" : "off")",
        ]
        for gesture in FlameGestureKind.allCases {
            lines.append("\(gesture.label) → \(s.reaction(for: gesture).label)")
        }
        if let data = try? JSONEncoder.pretty.encode(s),
           let json = String(data: data, encoding: .utf8) {
            lines.append(json)
        }
        return lines.joined(separator: "\n")
    }

    private func persist() {
        var clamped = settings
        clamped.clamp()
        if let data = try? JSONEncoder().encode(clamped) {
            defaults.set(data, forKey: Self.storageKey)
        }
    }
}

private extension JSONEncoder {
    static var pretty: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }
}
