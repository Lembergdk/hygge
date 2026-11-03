#if DEBUG
import SwiftUI
import UIKit

/// Flame Lab: the design-it-yourself surface for the interactive flame.
/// DEBUG builds only — it never ships in release UI. Play with the stage
/// flame (tap his head/body/feet, flick, pinch, tilt the phone, shake),
/// remap any gesture to any reaction, tune the feel with sliders, then
/// copy your picks and hand them back to be baked in as the defaults.
/// Every change applies live everywhere via FlamePlayStore and is kept
/// on this phone until reset.
struct FlameLabView: View {
    @Environment(FlamePlayStore.self) private var playStore
    @State private var preview: FlamePreviewRequest?
    @State private var previewCounter = 0
    @State private var lastGesture: FlameGestureKind?
    @State private var lastReaction: FlameReactionKind?
    @State private var copied = false

    var body: some View {
        @Bindable var play = playStore
        SettingsPage(title: "Flame Lab") {
            stage(play: play)
            feelSection(play: play)
            reactionsSection(play: play)
            shareSection
        }
    }

    private func stage(play: FlamePlayStore) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 22)
                    .fill(HyggeTheme.paperDeep)
                InteractiveFlame(
                    hitHeight: CGFloat(play.settings.homeFlameSize) * 1.25,
                    preview: preview,
                    onGesture: { gesture, reaction in
                        lastGesture = gesture
                        lastReaction = reaction
                    }
                ) {
                    AnimatedFlame(animation: .walk, size: CGFloat(play.settings.homeFlameSize))
                        .shadow(color: .black.opacity(0.18), radius: 10, y: 5)
                }
            }
            .frame(height: 300)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Flame playground")
            .accessibilityIdentifier("flameLab.stage")

            if let lastGesture, let lastReaction {
                Text("\(lastGesture.label) → \(lastReaction.label)")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HyggeTheme.ink)
            } else {
                Text("Tap his head, body or feet. Flick him. Pinch. Tilt the phone. Shake it.")
                    .font(.subheadline)
                    .foregroundStyle(HyggeTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func feelSection(play: FlamePlayStore) -> some View {
        @Bindable var play = play
        return VStack(alignment: .leading, spacing: 14) {
            sectionTitle("How it feels")
            slider("Home size", value: $play.settings.homeFlameSize,
                   range: 81...170, format: { "\(Int($0)) pt" })
            slider("Liveliness", value: $play.settings.liveliness,
                   range: 0.4...2, format: { String(format: "%.2f×", $0) })
            slider("Jump height", value: $play.settings.jumpHeight,
                   range: 8...40, format: { "\(Int($0)) pt" })
            slider("Gyro lean", value: $play.settings.gyroLeanDegrees,
                   range: 0...14, format: { "\(Int($0))°" })
            slider("Idle every", value: $play.settings.idleInterval,
                   range: 2.5...10, format: { String(format: "%.1f s", $0) })
            Toggle("Idle behavior", isOn: $play.settings.idleEnabled)
            Toggle("Gyro lean", isOn: $play.settings.gyroEnabled)
        }
        .settingsSurface()
    }

    private func reactionsSection(play: FlamePlayStore) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionTitle("Who does what")
            ForEach(FlameGestureKind.allCases) { gesture in
                HStack(spacing: 10) {
                    Text(gesture.label)
                        .font(.subheadline)
                        .foregroundStyle(HyggeTheme.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Picker(gesture.label, selection: reactionBinding(play, gesture)) {
                        ForEach(FlameReactionKind.allCases) { reaction in
                            Text(reaction.label).tag(reaction)
                        }
                    }
                    .labelsHidden()
                    Button("Try") { tryReaction(play.settings.reaction(for: gesture)) }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HyggeTheme.sageDeep)
                        .frame(minWidth: 44, minHeight: 36)
                }
                if gesture != FlameGestureKind.allCases.last { Divider() }
            }
        }
        .settingsSurface()
    }

    private var shareSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionTitle("Keep your picks")
            Text("Your choices are already live on this phone. Copy them and paste them in chat to make them the shipped defaults.")
                .font(.caption)
                .foregroundStyle(HyggeTheme.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 12) {
                Button(copied ? "Copied" : "Copy my picks") {
                    UIPasteboard.general.string = playStore.exportText
                    copied = true
                }
                .buttonStyle(SettingsActionStyle())
                ShareLink(item: playStore.exportText) {
                    Text("Share")
                }
                .buttonStyle(SettingsActionStyle(filled: false))
            }
            Button("Reset to defaults", role: .destructive) {
                playStore.reset()
                copied = false
            }
            .font(.subheadline.weight(.medium))
            .frame(minHeight: 44)
        }
        .settingsSurface()
    }

    private func sectionTitle(_ text: String) -> some View {
        Text(text)
            .font(.system(.title3, design: .rounded, weight: .bold))
            .foregroundStyle(HyggeTheme.ink)
    }

    private func slider(_ title: String, value: Binding<Double>,
                        range: ClosedRange<Double>,
                        format: @escaping (Double) -> String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(title).font(.subheadline).foregroundStyle(HyggeTheme.ink)
                Spacer()
                Text(format(value.wrappedValue))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HyggeTheme.secondary)
            }
            Slider(value: value, in: range)
                .tint(HyggeTheme.sageDeep)
                .accessibilityLabel(title)
        }
    }

    private func reactionBinding(_ play: FlamePlayStore,
                                 _ gesture: FlameGestureKind) -> Binding<FlameReactionKind> {
        Binding(get: { play.settings.reaction(for: gesture) },
                set: { play.settings.setReaction($0, for: gesture) })
    }

    private func tryReaction(_ reaction: FlameReactionKind) {
        previewCounter += 1
        preview = FlamePreviewRequest(id: previewCounter, reaction: reaction)
    }
}
#endif
