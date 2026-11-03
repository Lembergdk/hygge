#if DEBUG
import SwiftUI
import UIKit

/// Flame Lab: the design-it-yourself surface for the interactive flame.
/// DEBUG builds only — it never ships in release UI. The stage stays
/// pinned on top so he is always in view while you work: play with him
/// (tap zones, flicks, pinch, drag him around, tilt, shake), remap any
/// gesture, describe in your own words what it *should* do, tune the
/// feel, then copy your picks back to become the shipped defaults.
///
/// Descriptions are saved with the picks today; they will generate
/// behaviors automatically once the backend description-to-behavior
/// route lands. Until then the menu choice is what he does — and your
/// words ride along in "Copy my picks" so they can be hand-built.
struct FlameLabView: View {
    @Environment(FlamePlayStore.self) private var playStore
    @State private var preview: FlamePreviewRequest?
    @State private var previewCounter = 0
    @State private var lastGesture: FlameGestureKind?
    @State private var lastReaction: FlameReactionKind?
    @State private var copied = false
    @FocusState private var descriptionFocus: FlameGestureKind?

    var body: some View {
        @Bindable var play = playStore
        VStack(spacing: 0) {
            stage(play: play)
                .padding(.horizontal, 22).padding(.top, 14).padding(.bottom, 10)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    reactionsSection(play: play)
                    feelSection(play: play)
                    shareSection
                }
                .padding(22).padding(.bottom, 20)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .background(HyggeTheme.paper)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { descriptionFocus = nil }
            }
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationTitle("Flame Lab")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(HyggeTheme.paper, for: .navigationBar)
        .tint(HyggeTheme.sageDeep)
        .fontDesign(.rounded)
    }

    private func stage(play: FlamePlayStore) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ZStack {
                RoundedRectangle(cornerRadius: 22)
                    .fill(HyggeTheme.paperDeep)
                FlameActor(size: CGFloat(play.settings.homeFlameSize),
                           preview: preview,
                           onGesture: { gesture, reaction in
                               lastGesture = gesture
                               lastReaction = reaction
                           })
            }
            .frame(height: 240)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Flame playground")
            .accessibilityIdentifier("flameLab.stage")

            if let lastGesture, let lastReaction {
                Text("\(lastGesture.label) → \(lastReaction.label)")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HyggeTheme.ink)
            } else {
                Text("Tap his head, body or feet. Flick him. Pinch. Twirl him till he's sick. Tilt or shake the phone.")
                    .font(.caption)
                    .foregroundStyle(HyggeTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func reactionsSection(play: FlamePlayStore) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("Who does what")
            Text("Pick what he does today — and/or describe in your own words what he should do. Descriptions are saved with your picks and will generate the behavior automatically once the backend route lands; until then, include them in Copy my picks and they'll be hand-built from your words.")
                .font(.caption)
                .foregroundStyle(HyggeTheme.secondary)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(FlameGestureKind.allCases) { gesture in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 10) {
                        Text(gesture.label)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(HyggeTheme.ink)
                        Spacer()
                        Button("Try") { tryReaction(play.settings.reaction(for: gesture)) }
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(HyggeTheme.sageDeep)
                            .frame(minWidth: 48, minHeight: 36)
                    }
                    Picker(gesture.label, selection: reactionBinding(play, gesture)) {
                        ForEach(FlameReactionKind.allCases) { reaction in
                            Text(reaction.label).tag(reaction)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                    .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
                    .settingsField()
                    TextField("Describe your own…",
                              text: descriptionBinding(play, gesture), axis: .vertical)
                        .focused($descriptionFocus, equals: gesture)
                        .lineLimit(1...3)
                        .font(.subheadline)
                        .settingsField()
                        .accessibilityLabel("Your description for \(gesture.label)")
                }
                .padding(.vertical, 6)
                if gesture != FlameGestureKind.allCases.last { Divider() }
            }
        }
        .settingsSurface()
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
            if play.settings.placement != nil {
                Button("Send him back to his corner") { play.settings.placement = nil }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HyggeTheme.sageDeep)
                    .frame(minHeight: 44)
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

    private func descriptionBinding(_ play: FlamePlayStore,
                                    _ gesture: FlameGestureKind) -> Binding<String> {
        Binding(get: { play.settings.description(for: gesture) },
                set: { play.settings.setDescription($0, for: gesture) })
    }

    private func tryReaction(_ reaction: FlameReactionKind) {
        previewCounter += 1
        preview = FlamePreviewRequest(id: previewCounter, reaction: reaction)
    }
}
#endif
