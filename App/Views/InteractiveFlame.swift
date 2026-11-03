import SwiftUI

/// One external "show me this reaction" request, used by Flame Lab's Try
/// buttons. `id` changes on every tap so repeats re-trigger.
struct FlamePreviewRequest: Equatable {
    var id: Int
    var reaction: FlameReactionKind
}

/// Makes any flame view physically present and playful. Layers, inside
/// out: a constant gentle breath; a reaction engine (squashes, hops,
/// twirls…) driven by an explorable gesture vocabulary — tap zones
/// (head/body/feet), four flicks, pinch in/out, phone shake — each
/// remappable in Flame Lab; gyro counter-lean (a flame fights to stay
/// upright); and an idle loop (looks around, taps a foot, stretches,
/// mini-hops) whenever nothing has happened for a while.
///
/// This layer only transforms the existing artwork. Mood/clip selection
/// stays with AnimatedFlame/FloatingFlame, and the caller's tap and
/// long-press meanings are forwarded via `onTap`/`onLongPress` (a
/// zero-distance drag owns classification precisely so it can never
/// swallow them the way it did in step 1 testing).
struct InteractiveFlame<Content: View>: View {
    /// Full touch vocabulary. Turn off where swipes belong to the parent
    /// (intro carousel paging) — gyro, breath and idle still run.
    var interactive = true
    var idleEnabled = true
    /// Height of the touch area, for tap-zone classification.
    var hitHeight: CGFloat = 170
    var preview: FlamePreviewRequest? = nil
    var onTap: (() -> Void)? = nil
    var onLongPress: (() -> Void)? = nil
    /// Lab readout: every recognized gesture and the reaction it fired.
    var onGesture: ((FlameGestureKind, FlameReactionKind) -> Void)? = nil
    @ViewBuilder var content: Content

    @Environment(FlamePlayStore.self) private var playStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var motion = FlameMotionService()
    @GestureState private var dragTranslation: CGSize = .zero
    @State private var breathing = false
    @State private var offsetX: CGFloat = 0
    @State private var offsetY: CGFloat = 0
    @State private var scaleX: CGFloat = 1
    @State private var scaleY: CGFloat = 1
    @State private var tiltDegrees: Double = 0
    @State private var spinDegrees: Double = 0
    @State private var pinchScale: CGFloat = 1
    @State private var reactionTask: Task<Void, Never>?
    @State private var pendingTapTask: Task<Void, Never>?
    @State private var idlePlanner = FlameIdlePlanner()
    @State private var lastInteraction = Date()
    @State private var lastPinchEnd = Date.distantPast
    @State private var longPressFired = false

    private var settings: FlameInteractionSettings { playStore.settings }

    private var gyroOn: Bool {
        settings.gyroEnabled && !reduceMotion && scenePhase == .active
    }

    private var tilt: FlameTilt {
        guard !reduceMotion else { return .zero }
        let drag = FlameTiltMapper.pointerTilt(
            translationX: Double(dragTranslation.width),
            translationY: Double(dragTranslation.height),
            width: 180, height: 180)
        let gyro = settings.gyroEnabled ? motion.tilt : .zero
        return FlameTilt(x: gyro.x + drag.x, y: gyro.y + drag.y)
    }

    var body: some View {
        content
            // Breath: always there, always subtle.
            .scaleEffect(x: breathing && !reduceMotion ? 0.995 : 1,
                         y: breathing && !reduceMotion ? 1.02 : 1,
                         anchor: .bottom)
            .animation(.easeInOut(duration: 1.7).repeatForever(autoreverses: true),
                       value: breathing)
            // Reaction pose.
            .offset(x: offsetX, y: offsetY)
            .scaleEffect(x: scaleX * pinchScale, y: scaleY * pinchScale, anchor: .bottom)
            .rotationEffect(.degrees(tiltDegrees), anchor: .bottom)
            .rotation3DEffect(.degrees(spinDegrees), axis: (x: 0, y: 1, z: 0))
            // Gyro counter-lean + finger drag drift.
            .rotationEffect(.degrees(-tilt.x * settings.gyroLeanDegrees), anchor: .bottom)
            .offset(x: tilt.x * 8 * settings.liveliness + dragTranslation.width * 0.12,
                    y: tilt.y * 5 + dragTranslation.height * 0.10)
            .simultaneousGesture(dragGesture, including: interactive ? .gesture : .none)
            .simultaneousGesture(pinchGesture, including: interactive ? .gesture : .none)
            .simultaneousGesture(longPressGesture,
                                 including: interactive && onLongPress != nil ? .gesture : .none)
            .onAppear {
                breathing = true
                updateMotion()
            }
            .onDisappear {
                motion.stop()
                reactionTask?.cancel()
                pendingTapTask?.cancel()
            }
            .onChange(of: scenePhase) { updateMotion() }
            .onChange(of: reduceMotion) { updateMotion() }
            .onChange(of: settings.gyroEnabled) { updateMotion() }
            .onChange(of: motion.shakeCount) {
                if interactive { fire(.shake, direction: 0, intensity: 1) }
            }
            .onChange(of: preview) { _, request in
                if let request { perform(request.reaction, direction: 1, intensity: 1) }
            }
            .task(id: idleLoopActive) { await runIdleLoop() }
    }

    private var idleLoopActive: Bool {
        idleEnabled && settings.idleEnabled && !reduceMotion && scenePhase == .active
    }

    // MARK: - Gestures

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .updating($dragTranslation) { value, state, _ in
                state = value.translation
            }
            .onChanged { _ in lastInteraction = Date() }
            .onEnded { value in
                lastInteraction = Date()
                if longPressFired {
                    longPressFired = false
                    return
                }
                // A pinch also ends a drag; never double-classify it.
                guard Date().timeIntervalSince(lastPinchEnd) > 0.3 else { return }
                let kind = FlameGestureClassifier.classify(
                    translationX: Double(value.translation.width),
                    translationY: Double(value.translation.height),
                    predictedX: Double(value.predictedEndTranslation.width),
                    predictedY: Double(value.predictedEndTranslation.height),
                    tapNormalizedY: hitHeight > 0
                        ? Double(value.startLocation.y / hitHeight) : 0.5)
                guard let kind else { return }
                let direction: CGFloat
                switch kind {
                case .swipeLeft: direction = -1
                case .swipeRight: direction = 1
                case .tapHead, .tapBody, .tapFeet:
                    // Poked from his left, he recoils right, and vice versa.
                    direction = value.startLocation.x < hitHeight * 0.45 ? 1 : -1
                default: direction = 0
                }
                let predicted = hypot(value.predictedEndTranslation.width,
                                      value.predictedEndTranslation.height)
                let intensity = min(1.5, max(0.8, Double(predicted) / 220))
                fire(kind, direction: direction, intensity: intensity)
                if kind == .tapHead || kind == .tapBody || kind == .tapFeet {
                    scheduleTap()
                }
            }
    }

    private var pinchGesture: some Gesture {
        MagnifyGesture()
            .onChanged { value in
                lastInteraction = Date()
                pinchScale = min(1.6, max(0.6, value.magnification))
            }
            .onEnded { value in
                lastInteraction = Date()
                lastPinchEnd = Date()
                withAnimation(.spring(response: 0.35, dampingFraction: 0.65)) {
                    pinchScale = 1
                }
                if value.magnification < 0.82 {
                    fire(.pinchIn, direction: 0, intensity: 1)
                } else if value.magnification > 1.18 {
                    fire(.pinchOut, direction: 0, intensity: 1)
                }
            }
    }

    private var longPressGesture: some Gesture {
        LongPressGesture(minimumDuration: 0.6, maximumDistance: 12)
            .onEnded { _ in
                longPressFired = true
                onLongPress?()
            }
    }

    /// The Home tap opens chat — but only after his reaction has had a
    /// beat to be seen, like a button that bounces before it acts.
    private func scheduleTap() {
        guard let onTap else { return }
        pendingTapTask?.cancel()
        pendingTapTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(280))
            if !Task.isCancelled { onTap() }
        }
    }

    // MARK: - Reactions

    private func fire(_ gesture: FlameGestureKind, direction: CGFloat, intensity: Double) {
        let reaction = settings.reaction(for: gesture)
        onGesture?(gesture, reaction)
        perform(reaction, direction: direction, intensity: intensity)
    }

    private func perform(_ reaction: FlameReactionKind, direction: CGFloat, intensity: Double) {
        guard !reduceMotion, reaction != .none else { return }
        lastInteraction = Date()
        reactionTask?.cancel()
        let live = settings.liveliness * intensity
        let jump = CGFloat(settings.jumpHeight * live)
        reactionTask = Task { @MainActor in
            await run(reaction, direction: direction, jump: jump, live: live)
            if !Task.isCancelled { await rest() }
        }
    }

    private func run(_ reaction: FlameReactionKind, direction: CGFloat,
                     jump: CGFloat, live: Double) async {
        let d = direction == 0 ? 1 : direction
        switch reaction {
        case .none:
            break
        case .pat:
            await pose(dy: 2, sx: 1.12, sy: 0.82, .easeIn(duration: 0.12), hold: 0.12)
            await pose(dy: -2, sx: 0.96, sy: 1.06, .spring(response: 0.3, dampingFraction: 0.55), hold: 0.3)
        case .poke:
            await pose(dx: d * 8 * CGFloat(live), sx: 0.94, rot: Double(d) * 6,
                       .easeOut(duration: 0.1), hold: 0.1)
            await pose(dx: -d * 2, rot: Double(-d) * 2,
                       .spring(response: 0.35, dampingFraction: 0.5), hold: 0.35)
        case .footTapDance:
            for i in 0..<4 where !Task.isCancelled {
                let s: CGFloat = i.isMultiple(of: 2) ? -1 : 1
                await pose(dy: -3, rot: Double(s) * 5, .easeInOut(duration: 0.09), hold: 0.09)
            }
            await hop(height: jump * 0.4)
        case .miniHop, .walkAbout:
            await hop(height: jump * 0.45)
        case .bigJump, .pointUp:
            await pose(dy: 4, sx: 1.1, sy: 0.86, .easeIn(duration: 0.11), hold: 0.11)
            await pose(dy: -jump, sx: 0.95, sy: 1.06, rot: -4, .easeOut(duration: 0.22), hold: 0.22)
            await pose(dy: 2, sx: 1.1, sy: 0.88, .easeIn(duration: 0.12), hold: 0.12)
            await pose(dy: -jump * 0.18, .spring(response: 0.3, dampingFraction: 0.6), hold: 0.3)
        case .duck:
            await pose(dy: 8, sx: 1.14, sy: 0.78, .easeIn(duration: 0.14), hold: 0.3)
            await pose(dy: 4, sx: 1.07, sy: 0.9, .easeOut(duration: 0.12), hold: 0.18)
        case .sideHop:
            await pose(dy: 3, sx: 1.08, sy: 0.9, .easeIn(duration: 0.09), hold: 0.09)
            await pose(dx: d * 17 * CGFloat(live), dy: -jump * 0.55, rot: Double(d) * 7,
                       .easeOut(duration: 0.2), hold: 0.2)
            await pose(dx: d * 10, dy: 2, sx: 1.09, sy: 0.89, .easeIn(duration: 0.11), hold: 0.11)
        case .twirl, .turnAround:
            withAnimation(.easeInOut(duration: 0.55)) { spinDegrees += 360 }
            await pose(dy: -jump * 0.3, .easeOut(duration: 0.27), hold: 0.28)
            await pose(dy: 2, sx: 1.08, sy: 0.9, .easeIn(duration: 0.12), hold: 0.12)
        case .wiggle, .wave, .laugh:
            for rot in [-7.0, 7, -5, 5, -2] where !Task.isCancelled {
                await pose(dy: -2, rot: rot, .easeInOut(duration: 0.07), hold: 0.07)
            }
        case .stretch:
            await pose(dy: -3, sx: 0.93, sy: 1.12, .easeInOut(duration: 0.28), hold: 0.55)
        case .puffUp:
            await pose(dy: -2, sx: 1.18, sy: 1.18, .spring(response: 0.32, dampingFraction: 0.6), hold: 0.42)
        case .shrinkStartle:
            await pose(dy: 3, sx: 0.8, sy: 0.8, .easeIn(duration: 0.1), hold: 0.2)
            await pose(sx: 1.04, sy: 1.04, .spring(response: 0.3, dampingFraction: 0.55), hold: 0.3)
        case .dizzy, .cry, .nauseous:
            for rot in [-10.0, 10, -8, 8, -4] where !Task.isCancelled {
                await pose(dx: CGFloat(rot) * 0.4, sy: 0.97, rot: rot,
                           .easeInOut(duration: 0.13), hold: 0.13)
            }
        }
    }

    private func hop(height: CGFloat) async {
        await pose(dy: 3, sx: 1.07, sy: 0.91, .easeIn(duration: 0.09), hold: 0.09)
        await pose(dy: -height, sx: 0.96, sy: 1.05, .easeOut(duration: 0.18), hold: 0.18)
        await pose(dy: 2, sx: 1.08, sy: 0.9, .easeIn(duration: 0.1), hold: 0.1)
    }

    /// One animated pose; unspecified components return to rest values.
    private func pose(dx: CGFloat = 0, dy: CGFloat = 0, sx: CGFloat = 1, sy: CGFloat = 1,
                      rot: Double = 0, _ animation: Animation, hold: Double) async {
        if Task.isCancelled { return }
        withAnimation(animation) {
            offsetX = dx; offsetY = dy; scaleX = sx; scaleY = sy; tiltDegrees = rot
        }
        try? await Task.sleep(for: .seconds(hold))
    }

    private func rest() async {
        await pose(.spring(response: 0.38, dampingFraction: 0.62), hold: 0.38)
        reactionTask = nil
    }

    // MARK: - Idle life

    private func runIdleLoop() async {
        // Give him a moment to simply arrive before the fidgeting starts.
        try? await Task.sleep(for: .seconds(2.5))
        while !Task.isCancelled {
            let step = idlePlanner.next()
            let wait = settings.idleInterval * step.delayFactor / max(0.5, settings.liveliness)
            try? await Task.sleep(for: .seconds(wait))
            guard !Task.isCancelled, reactionTask == nil,
                  Date().timeIntervalSince(lastInteraction) > 3 else { continue }
            await runIdle(step.action)
            if !Task.isCancelled { await rest() }
        }
    }

    private func runIdle(_ action: FlameIdleAction) async {
        switch action {
        case .lookLeft:
            await pose(dx: -4, rot: -3.5, .easeInOut(duration: 0.3), hold: 0.8)
        case .lookRight:
            await pose(dx: 4, rot: 3.5, .easeInOut(duration: 0.3), hold: 0.8)
        case .footTap:
            for i in 0..<3 where !Task.isCancelled {
                let s: CGFloat = i.isMultiple(of: 2) ? -1 : 1
                await pose(dy: -1.5, rot: Double(s) * 2.5, .easeInOut(duration: 0.1), hold: 0.12)
            }
        case .stretch:
            await pose(dy: -2, sx: 0.96, sy: 1.07, .easeInOut(duration: 0.35), hold: 0.7)
        case .miniHop:
            await hop(height: CGFloat(7 * settings.liveliness))
        case .wiggle:
            for rot in [-3.5, 3.5, -2.0] where !Task.isCancelled {
                await pose(rot: rot, .easeInOut(duration: 0.1), hold: 0.1)
            }
        }
    }

    private func updateMotion() {
        if gyroOn { motion.start() } else { motion.stop() }
    }
}


