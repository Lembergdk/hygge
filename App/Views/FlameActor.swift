import SwiftUI

/// The living flame: a layered rig (RiggedFlame) driven by a performance
/// engine, gyro lean, idle life, drag-anywhere carrying with flailing
/// limbs, twirl-until-nauseous, and the explorable gesture vocabulary.
/// Every reaction is a little scene — face, arms, legs and body together —
/// and each gesture's scene is remappable in Flame Lab.
struct FlameActor: View {
    var size: CGFloat
    var clipOverride: FlameAnimation? = nil
    var attention = false
    var interactive = true
    var movable = false
    var traveling = false
    var preview: FlamePreviewRequest? = nil
    var onTap: (() -> Void)? = nil
    var onLongPress: (() -> Void)? = nil
    var onGesture: ((FlameGestureKind, FlameReactionKind) -> Void)? = nil
    var onDragBegan: (() -> Void)? = nil
    /// Final drag translation to commit as his new spot, or nil when the
    /// release was a flick (he reacts instead of moving).
    var onDragEnded: ((CGSize?) -> Void)? = nil

    @Environment(FlamePlayStore.self) private var playStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var motion = FlameMotionService()
    @State private var pose = FlamePose.rest
    @State private var breathing = false
    @State private var walkCycle = false
    @State private var pinchScale: CGFloat = 1
    @GestureState private var dragTranslation: CGSize = .zero
    @State private var isDragging = false
    @State private var spinAccum: Double = 0
    @State private var lastDragAngle: Double?
    @State private var pendingNausea = false
    // Secondary-motion springs for carried limbs.
    @State private var armSLVel: Double = 0
    @State private var armSRVel: Double = 0
    @State private var legSLVel: Double = 0
    @State private var legSRVel: Double = 0
    @State private var rotVel: Double = 0
    @State private var smoothVX: Double = 0
    @State private var smoothVY: Double = 0
    @State private var lastDragSample: (time: Date, translation: CGSize)?
    @State private var lastSampleDT: Double = 1.0 / 60
    /// Classification buffer: a touch starts undecided; nothing follows
    /// the finger until it is known to be a carry rather than a flick.
    private enum DragPhase { case deciding, carrying, flickArmed, tracking }
    @State private var dragPhase: DragPhase?
    @State private var touchBeganAt: Date?
    /// Smoothed follow offset while carried (catches up after the buffer,
    /// hangs him below the fingertip so his whole body stays visible).
    @State private var displayDrag: CGSize = .zero
    @State private var travelTask: Task<Void, Never>?

    /// How far below the finger he hangs while carried.
    private var carryLift: CGFloat { size * 0.52 }
    @State private var reactionTask: Task<Void, Never>?
    @State private var pendingTapTask: Task<Void, Never>?
    @State private var idlePlanner = FlameIdlePlanner()
    @State private var lastInteraction = Date()
    @State private var lastPinchEnd = Date.distantPast
    @State private var longPressFired = false

    private var settings: FlameInteractionSettings { playStore.settings }
    private var height: CGFloat { size * 1.25 }

    private var gyroOn: Bool {
        settings.gyroEnabled && !reduceMotion && scenePhase == .active
    }

    private var tilt: FlameTilt {
        guard !reduceMotion else { return .zero }
        let drag = FlameTiltMapper.pointerTilt(
            translationX: Double(dragTranslation.width),
            translationY: Double(dragTranslation.height), width: 180, height: 180)
        let gyro = settings.gyroEnabled ? motion.tilt : .zero
        return FlameTilt(x: gyro.x + drag.x, y: gyro.y + drag.y)
    }

    var body: some View {
        RiggedFlame(pose: pose, size: size,
                    walking: walkCycle && !reduceMotion,
                    clipOverride: clipOverride)
            .scaleEffect(x: breathing && !reduceMotion ? 0.995 : 1,
                         y: breathing && !reduceMotion ? 1.02 : 1, anchor: .bottom)
            .animation(.easeInOut(duration: 1.7).repeatForever(autoreverses: true),
                       value: breathing)
            .scaleEffect(pinchScale, anchor: .bottom)
            .rotationEffect(.degrees(-tilt.x * settings.gyroLeanDegrees), anchor: .bottom)
            .offset(x: tilt.x * 8 * settings.liveliness + dragVisualOffset.width,
                    y: tilt.y * 5 + dragVisualOffset.height)
            .frame(width: size, height: height)
            .contentShape(Rectangle())
            .simultaneousGesture(dragGesture, including: interactive ? .gesture : .none)
            .simultaneousGesture(pinchGesture, including: interactive ? .gesture : .none)
            .simultaneousGesture(longPressGesture,
                                 including: interactive && onLongPress != nil ? .gesture : .none)
            .onAppear { breathing = true; updateMotion() }
            .onDisappear {
                motion.stop(); reactionTask?.cancel(); pendingTapTask?.cancel()
                travelTask?.cancel()
            }
            .onChange(of: traveling) { _, now in
                if now { startTravelHops() }
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
        settings.idleEnabled && !reduceMotion && scenePhase == .active
    }

    private var dragVisualOffset: CGSize {
        switch dragPhase {
        case .carrying:
            return displayDrag
        case .flickArmed:
            // A whisper of follow so the wind-up reads, never a mini-drag.
            return CGSize(width: min(6, max(-6, dragTranslation.width * 0.08)),
                          height: min(6, max(-6, dragTranslation.height * 0.08)))
        case .tracking:
            return CGSize(width: dragTranslation.width * 0.12,
                          height: dragTranslation.height * 0.10)
        case .deciding, nil:
            return .zero
        }
    }

    /// Hops while he travels between spots: crouch, airborne with limbs
    /// tucked and arms up, land — repeated until he arrives.
    private func startTravelHops() {
        guard !reduceMotion else { return }
        travelTask?.cancel()
        reactionTask?.cancel()
        let airHeight = CGFloat(settings.jumpHeight * settings.liveliness) * 0.9
        travelTask = Task { @MainActor in
            while !Task.isCancelled && traveling {
                await pose(.easeIn(duration: 0.11), hold: 0.11) { p in
                    p.dy = 3; p.sx = 1.08; p.sy = 0.9; p.face = .happy
                    p.legSL = 18; p.legSR = -18
                }
                if Task.isCancelled || !traveling { break }
                await pose(.easeOut(duration: 0.16), hold: 0.30) { p in
                    p.dy = -airHeight; p.sy = 1.05; p.face = .laugh
                    p.armSL = 148; p.armSR = -148; p.legSL = 30; p.legSR = -24
                }
                if Task.isCancelled || !traveling { break }
                await pose(.easeIn(duration: 0.11), hold: 0.11) { p in
                    p.dy = 2; p.sx = 1.08; p.sy = 0.9; p.face = .happy
                }
            }
            if !Task.isCancelled { await rest() }
            travelTask = nil
        }
    }

    private func beginTouch(_ value: DragGesture.Value) {
        touchBeganAt = Date()
        dragPhase = .deciding
        smoothVX = 0; smoothVY = 0
        lastDragSample = (Date(), value.translation)
        reactionTask?.cancel()
        pendingTapTask?.cancel()
        if !reduceMotion {
            withAnimation(.easeOut(duration: 0.12)) {
                var p = FlamePose.rest
                p.sy = 0.97; p.sx = 1.02
                pose = p
            }
        }
    }

    private func updateVelocity(_ value: DragGesture.Value) {
        let now = Date()
        if let last = lastDragSample {
            let raw = now.timeIntervalSince(last.time)
            if raw > 0.001 {
                lastSampleDT = min(raw, 0.05)
                smoothVX += (Double(value.translation.width - last.translation.width) / raw - smoothVX) * 0.35
                smoothVY += (Double(value.translation.height - last.translation.height) / raw - smoothVY) * 0.35
            }
        }
        lastDragSample = (now, value.translation)
    }

    /// Wind-up while a flick is armed: crouch/lean *with* the flick so
    /// the release reaction continues a motion already started.
    private func anticipationPose(_ value: DragGesture.Value) {
        guard !reduceMotion else { return }
        let mag = max(1, hypot(value.translation.width, value.translation.height))
        let ux = Double(value.translation.width / mag)
        let uy = Double(value.translation.height / mag)
        var p = FlamePose.rest
        p.face = .surprised
        p.rot = ux * 7
        p.dy = CGFloat(max(0, -uy) * 3)
        p.sy = CGFloat(1 - max(0, -uy) * 0.09 + max(0, uy) * 0.04)
        p.sx = CGFloat(1 + max(0, -uy) * 0.06)
        p.armSL = 26 + ux * 22
        p.armSR = -26 + ux * 22
        p.legSL = max(0, -uy) * 18
        p.legSR = -max(0, -uy) * 18
        withAnimation(.easeOut(duration: 0.09)) { pose = p }
    }

    // MARK: - Gestures

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .updating($dragTranslation) { value, state, _ in state = value.translation }
            .onChanged { value in
                lastInteraction = Date()
                guard !traveling else { return }
                if touchBeganAt == nil { beginTouch(value) }
                updateVelocity(value)
                let mag = hypot(value.translation.width, value.translation.height)
                let elapsed = touchBeganAt.map { Date().timeIntervalSince($0) } ?? 0
                switch dragPhase {
                case .deciding, nil:
                    switch FlameGestureClassifier.dragIntent(
                        elapsed: elapsed, magnitude: Double(mag),
                        velocity: hypot(smoothVX, smoothVY)) {
                    case .flick:
                        dragPhase = .flickArmed
                        anticipationPose(value)
                    case .carry:
                        if movable {
                            dragPhase = .carrying
                            isDragging = true
                            spinAccum = 0
                            lastDragAngle = nil
                            pendingNausea = false
                            resetSprings()
                            displayDrag = .zero
                            onDragBegan?()
                        } else {
                            dragPhase = .tracking
                        }
                    case .deciding:
                        break
                    }
                case .flickArmed:
                    anticipationPose(value)
                case .carrying:
                    // Catch up to the finger (plus the below-finger hang)
                    // with a fast spring — no snap after the buffer.
                    let k = min(1, lastSampleDT * 18)
                    displayDrag.width += (value.translation.width - displayDrag.width) * k
                    displayDrag.height += (value.translation.height + carryLift - displayDrag.height) * k
                    trackSpin(value.location)
                    heldPose(value)
                case .tracking:
                    break
                }
            }
            .onEnded { value in
                lastInteraction = Date()
                let phase = dragPhase
                touchBeganAt = nil
                dragPhase = nil
                displayDrag = .zero
                if longPressFired { longPressFired = false; return }
                if phase == .carrying {
                    isDragging = false
                    resetSprings()
                    let committed = CGSize(width: value.translation.width,
                                           height: value.translation.height + carryLift)
                    if pendingNausea {
                        onDragEnded?(committed)
                        perform(.nauseous, direction: 0, intensity: 1.2)
                    } else if FlameGestureClassifier.isFlickRelease(
                        translationX: Double(value.translation.width),
                        translationY: Double(value.translation.height),
                        predictedX: Double(value.predictedEndTranslation.width),
                        predictedY: Double(value.predictedEndTranslation.height)),
                              let kind = FlameGestureClassifier.classify(
                        translationX: Double(value.translation.width),
                        translationY: Double(value.translation.height),
                        predictedX: Double(value.predictedEndTranslation.width),
                        predictedY: Double(value.predictedEndTranslation.height),
                        tapNormalizedY: 0.5) {
                        // A flick is a reaction, not a relocation.
                        onDragEnded?(nil)
                        let predicted = hypot(value.predictedEndTranslation.width,
                                              value.predictedEndTranslation.height)
                        let dir: CGFloat = kind == .swipeLeft ? -1 : (kind == .swipeRight ? 1 : 0)
                        fire(kind, direction: dir,
                             intensity: min(1.5, max(0.9, Double(predicted) / 220)))
                    } else {
                        onDragEnded?(committed)
                        land()
                    }
                    return
                }
                guard Date().timeIntervalSince(lastPinchEnd) > 0.3 else { return }
                let kind = FlameGestureClassifier.classify(
                    translationX: Double(value.translation.width),
                    translationY: Double(value.translation.height),
                    predictedX: Double(value.predictedEndTranslation.width),
                    predictedY: Double(value.predictedEndTranslation.height),
                    tapNormalizedY: height > 0 ? Double(value.startLocation.y / height) : 0.5)
                guard let kind else { return }
                let direction: CGFloat
                switch kind {
                case .swipeLeft: direction = -1
                case .swipeRight: direction = 1
                case .tapHead, .tapBody, .tapFeet:
                    direction = value.startLocation.x < size * 0.5 ? 1 : -1
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

    private func trackSpin(_ location: CGPoint) {
        let center = CGPoint(x: size / 2, y: height / 2)
        let angle = atan2(Double(location.y - center.y), Double(location.x - center.x))
        if let last = lastDragAngle {
            var delta = angle - last
            while delta > .pi { delta -= 2 * .pi }
            while delta < -.pi { delta += 2 * .pi }
            spinAccum += delta
            if abs(spinAccum) > 4.7 { pendingNausea = true }
        }
        lastDragAngle = angle
    }

    private func resetSprings() {
        armSLVel = 0; armSRVel = 0; legSLVel = 0; legSRVel = 0; rotVel = 0
    }

    /// One under-damped spring step: limbs chase their targets with lag
    /// and overshoot, so they trail, swing and settle like soft toys
    /// instead of snapping to a pose.
    private func spring(_ pos: Double, _ vel: inout Double,
                        toward target: Double, dt: Double) -> Double {
        let stiffness = 210.0, damping = 13.0
        vel += (stiffness * (target - pos) - damping * vel) * dt
        return pos + vel * dt
    }

    /// Carried like a plush toy, with secondary motion: arms up but
    /// trailing the hand, legs dangling and pendulum-swinging against
    /// travel, body leaning and stretching with speed.
    private func heldPose(_ value: DragGesture.Value) {
        guard !reduceMotion else { return }
        let dt = lastSampleDT
        let vx = smoothVX, vy = smoothVY
        let speed = hypot(vx, vy)
        let trail = min(58, max(-58, -vx * 0.045))          // limbs lag behind travel
        let lift = min(26, max(-14, -vy * 0.016))           // rising hand lifts limbs
        var p = pose
        p.armSL = spring(p.armSL, &armSLVel, toward: 118 + trail + lift, dt: dt)
        p.armSR = spring(p.armSR, &armSRVel, toward: -118 + trail + lift, dt: dt)
        p.legSL = spring(p.legSL, &legSLVel, toward: trail * 0.95, dt: dt)
        p.legSR = spring(p.legSR, &legSRVel, toward: trail * 0.8 - 8, dt: dt)
        p.rot = spring(p.rot, &rotVel, toward: min(16, max(-16, vx * 0.016)), dt: dt)
        p.face = pendingNausea ? .dizzy : (speed > 90 ? .surprised : .normal)
        p.sx = 1 + min(0.05, abs(vx) * 0.00003)
        p.sy = 1 + min(0.05, max(0, -vy) * 0.00003)
        p.dy = -size * 0.02
        p.dx = 0
        pose = p
    }

    private func land() {
        guard !reduceMotion else { pose = .rest; return }
        reactionTask?.cancel()
        reactionTask = Task { @MainActor in
            await pose(.easeIn(duration: 0.1), hold: 0.1) { p in
                p.dy = 3; p.sx = 1.09; p.sy = 0.89; p.face = .happy
            }
            if !Task.isCancelled { await rest() }
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
                withAnimation(.spring(response: 0.35, dampingFraction: 0.65)) { pinchScale = 1 }
                if value.magnification < 0.82 { fire(.pinchIn, direction: 0, intensity: 1) }
                else if value.magnification > 1.18 { fire(.pinchOut, direction: 0, intensity: 1) }
            }
    }

    private var longPressGesture: some Gesture {
        LongPressGesture(minimumDuration: 0.6, maximumDistance: 12)
            .onEnded { _ in longPressFired = true; onLongPress?() }
    }

    private func scheduleTap() {
        guard let onTap else { return }
        pendingTapTask?.cancel()
        pendingTapTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(280))
            if !Task.isCancelled { onTap() }
        }
    }

    // MARK: - Performances

    private func fire(_ gesture: FlameGestureKind, direction: CGFloat, intensity: Double) {
        let reaction = settings.reaction(for: gesture)
        onGesture?(gesture, reaction)
        perform(reaction, direction: direction, intensity: intensity)
    }

    private func perform(_ reaction: FlameReactionKind, direction: CGFloat, intensity: Double) {
        guard !reduceMotion, reaction != .none, !isDragging else { return }
        lastInteraction = Date()
        reactionTask?.cancel()
        let live = settings.liveliness * intensity
        let jump = CGFloat(settings.jumpHeight * live)
        reactionTask = Task { @MainActor in
            await run(reaction, direction: direction, jump: jump, live: live)
            walkCycle = false
            if !Task.isCancelled { await rest() }
        }
    }

    private func pose(_ animation: Animation, hold: Double,
                      _ build: (inout FlamePose) -> Void = { _ in }) async {
        if Task.isCancelled { return }
        var p = FlamePose.rest
        build(&p)
        withAnimation(animation) { pose = p }
        try? await Task.sleep(for: .seconds(hold))
    }

    private func rest() async {
        await pose(.spring(response: 0.38, dampingFraction: 0.62), hold: 0.38)
        reactionTask = nil
    }

    private func hop(height: CGFloat, face: FlameFaceKind = .happy) async {
        await pose(.easeIn(duration: 0.09), hold: 0.09) { p in
            p.dy = 3; p.sx = 1.07; p.sy = 0.91
        }
        await pose(.easeOut(duration: 0.18), hold: 0.18) { p in
            p.dy = -height; p.sx = 0.96; p.sy = 1.05; p.face = face
            p.armSL = 95; p.armSR = -95; p.legSL = 14; p.legSR = -14
        }
        await pose(.easeIn(duration: 0.1), hold: 0.1) { p in
            p.dy = 2; p.sx = 1.08; p.sy = 0.9; p.face = face
        }
    }

    private func run(_ reaction: FlameReactionKind, direction: CGFloat,
                     jump: CGFloat, live: Double) async {
        let d = direction == 0 ? 1 : direction
        switch reaction {
        case .none:
            break
        case .pat:
            await pose(.easeIn(duration: 0.12), hold: 0.14) { p in
                p.dy = 2; p.sx = 1.12; p.sy = 0.82; p.face = .happy
                p.armSL = 22; p.armSR = -22
            }
            await pose(.spring(response: 0.3, dampingFraction: 0.55), hold: 0.35) { p in
                p.dy = -2; p.sx = 0.96; p.sy = 1.06; p.face = .happy
            }
        case .poke:
            await pose(.easeOut(duration: 0.1), hold: 0.12) { p in
                p.dx = d * 9 * CGFloat(live); p.rot = Double(d) * 6; p.face = .surprised
                p.armSL = 120; p.armSR = -120; p.legSL = 10; p.legSR = -10
            }
            await pose(.spring(response: 0.35, dampingFraction: 0.5), hold: 0.35) { p in
                p.dx = -d * 2; p.rot = Double(-d) * 2
            }
        case .footTapDance:
            for i in 0..<4 where !Task.isCancelled {
                let left = i.isMultiple(of: 2)
                await pose(.easeInOut(duration: 0.1), hold: 0.1) { p in
                    p.face = .happy; p.dy = -3
                    p.legSL = left ? 42 : -8; p.legSR = left ? 8 : -42
                    p.armSL = left ? -18 : 30; p.armSR = left ? -30 : 18
                    p.rot = left ? -3 : 3
                }
            }
            await hop(height: jump * 0.4)
        case .miniHop:
            await hop(height: jump * 0.45)
        case .bigJump:
            await pose(.easeIn(duration: 0.11), hold: 0.11) { p in
                p.dy = 4; p.sx = 1.1; p.sy = 0.86; p.legSL = 16; p.legSR = -16
            }
            await pose(.easeOut(duration: 0.22), hold: 0.24) { p in
                p.dy = -jump; p.sx = 0.95; p.sy = 1.06; p.rot = -4; p.face = .laugh
                p.armSL = 150; p.armSR = -150; p.legSL = 22; p.legSR = -22
            }
            await pose(.easeIn(duration: 0.12), hold: 0.12) { p in
                p.dy = 2; p.sx = 1.1; p.sy = 0.88; p.face = .happy
            }
            await pose(.spring(response: 0.3, dampingFraction: 0.6), hold: 0.3) { p in
                p.dy = -jump * 0.18; p.face = .happy; p.armSL = 60; p.armSR = -60
            }
        case .duck:
            await pose(.easeIn(duration: 0.14), hold: 0.32) { p in
                p.dy = 8; p.sx = 1.14; p.sy = 0.78; p.face = .sleepy
                p.armSL = 30; p.armSR = -30; p.legSL = 22; p.legSR = -22
            }
            await pose(.easeOut(duration: 0.12), hold: 0.2) { p in
                p.dy = 4; p.sx = 1.07; p.sy = 0.9; p.face = .normal
            }
        case .sideHop:
            await pose(.easeIn(duration: 0.09), hold: 0.09) { p in
                p.dy = 3; p.sx = 1.08; p.sy = 0.9
            }
            await pose(.easeOut(duration: 0.2), hold: 0.2) { p in
                p.dx = d * 17 * CGFloat(live); p.dy = -jump * 0.55
                p.rot = Double(d) * 7; p.face = .happy
                p.armSL = d < 0 ? 140 : 30; p.armSR = d < 0 ? -30 : -140
                p.legSL = 24; p.legSR = -24
            }
            await pose(.easeIn(duration: 0.11), hold: 0.11) { p in
                p.dx = d * 10; p.dy = 2; p.sx = 1.09; p.sy = 0.89; p.face = .happy
            }
        case .twirl:
            await pose(.easeIn(duration: 0.16), hold: 0.16) { p in
                p.flipX = 0.05; p.dy = -jump * 0.25; p.armSL = 80; p.armSR = -80
            }
            await pose(.easeOut(duration: 0.16), hold: 0.18) { p in
                p.flipX = -1; p.backTurned = true; p.armSL = 80; p.armSR = -80
            }
            await pose(.easeIn(duration: 0.16), hold: 0.16) { p in
                p.flipX = -0.05; p.backTurned = true; p.dy = -jump * 0.15
            }
            await pose(.spring(response: 0.32, dampingFraction: 0.6), hold: 0.35) { p in
                p.face = .dizzy
            }
        case .wiggle:
            for rot in [-7.0, 7, -5, 5, -2] where !Task.isCancelled {
                await pose(.easeInOut(duration: 0.07), hold: 0.07) { p in
                    p.dy = -2; p.rot = rot; p.face = .laugh
                    p.armSL = 40 + rot * 3; p.armSR = -40 + rot * 3
                }
            }
        case .stretch:
            await pose(.easeInOut(duration: 0.3), hold: 0.6) { p in
                p.dy = -3; p.sx = 0.93; p.sy = 1.12; p.face = .sleepy
                p.armSL = 165; p.armSR = -165
            }
            await pose(.spring(response: 0.35, dampingFraction: 0.6), hold: 0.3) { p in
                p.face = .happy
            }
        case .puffUp:
            await pose(.spring(response: 0.32, dampingFraction: 0.6), hold: 0.45) { p in
                p.dy = -2; p.sx = 1.18; p.sy = 1.18; p.face = .happy
                p.armSL = 52; p.armSR = -52; p.legSL = 14; p.legSR = -14
            }
        case .shrinkStartle:
            await pose(.easeIn(duration: 0.1), hold: 0.2) { p in
                p.dy = 3; p.sx = 0.8; p.sy = 0.8; p.face = .surprised
                p.armSL = 130; p.armSR = -130
            }
            await pose(.spring(response: 0.3, dampingFraction: 0.55), hold: 0.3) { p in
                p.sx = 1.04; p.sy = 1.04
            }
        case .dizzy:
            for rot in [-10.0, 10, -8, 8, -4] where !Task.isCancelled {
                await pose(.easeInOut(duration: 0.13), hold: 0.13) { p in
                    p.dx = CGFloat(rot) * 0.4; p.sy = 0.97; p.rot = rot; p.face = .dizzy
                    p.armSL = 60 + rot * 2; p.armSR = -60 + rot * 2
                }
            }
        case .wave:
            for angle in [-152.0, -118, -152, -118, -152] where !Task.isCancelled {
                await pose(.easeInOut(duration: 0.14), hold: 0.14) { p in
                    p.face = .happy; p.armSR = angle; p.armSL = 14; p.dy = -1
                }
            }
            await hop(height: jump * 0.3)
        case .pointUp:
            await pose(.easeOut(duration: 0.16), hold: 0.2) { p in
                p.face = .laugh; p.armSL = 148; p.armSR = -24; p.rot = -3
            }
            await hop(height: jump * 0.55, face: .laugh)
            await pose(.easeInOut(duration: 0.18), hold: 0.35) { p in
                p.face = .happy; p.armSL = 148; p.armSR = -24; p.rot = -3
            }
        case .laugh:
            for i in 0..<3 where !Task.isCancelled {
                await pose(.easeInOut(duration: 0.11), hold: 0.11) { p in
                    p.face = .laugh; p.dy = i.isMultiple(of: 2) ? -4 : 0
                    p.sy = i.isMultiple(of: 2) ? 1.03 : 0.98
                    p.armSL = 34; p.armSR = -34
                }
            }
        case .cry:
            await pose(.easeInOut(duration: 0.25), hold: 0.5) { p in
                p.face = .cry; p.dy = 3; p.sy = 0.95; p.armSL = 8; p.armSR = -8
            }
            for _ in 0..<2 where !Task.isCancelled {
                await pose(.easeInOut(duration: 0.14), hold: 0.14) { p in
                    p.face = .cry; p.dy = 4; p.sy = 0.93
                }
                await pose(.easeInOut(duration: 0.14), hold: 0.14) { p in
                    p.face = .cry; p.dy = 2; p.sy = 0.96
                }
            }
        case .nauseous:
            await pose(.easeInOut(duration: 0.25), hold: 0.3) { p in
                p.face = .sick; p.sickTint = 0.55; p.dy = 2; p.rot = -6
                p.armSL = -28; p.armSR = 28
            }
            for rot in [6.0, -5, 3] where !Task.isCancelled {
                await pose(.easeInOut(duration: 0.28), hold: 0.28) { p in
                    p.face = .sick; p.sickTint = 0.55; p.rot = rot; p.dy = 2
                    p.armSL = -28; p.armSR = 28
                }
            }
            await pose(.easeOut(duration: 0.3), hold: 0.3) { p in
                p.face = .dizzy; p.sickTint = 0.2
            }
        case .turnAround:
            await pose(.easeIn(duration: 0.16), hold: 0.16) { p in p.flipX = 0.05 }
            await pose(.easeOut(duration: 0.16), hold: 0.55) { p in
                p.flipX = -1; p.backTurned = true; p.armSL = 46; p.armSR = -46
            }
            await pose(.easeIn(duration: 0.16), hold: 0.16) { p in
                p.flipX = -0.05; p.backTurned = true
            }
            await pose(.spring(response: 0.32, dampingFraction: 0.6), hold: 0.3) { p in
                p.face = .happy
            }
        case .walkAbout:
            walkCycle = true
            await pose(.easeInOut(duration: 0.7), hold: 0.7) { p in
                p.dx = d * 22 * CGFloat(live); p.face = .normal
            }
            await pose(.easeInOut(duration: 0.7), hold: 0.7) { p in
                p.face = .happy
            }
            walkCycle = false
        }
    }

    // MARK: - Idle life

    private func runIdleLoop() async {
        try? await Task.sleep(for: .seconds(2.5))
        var pointNext = false
        while !Task.isCancelled {
            let step = idlePlanner.next()
            let wait = settings.idleInterval * step.delayFactor / max(0.5, settings.liveliness)
            try? await Task.sleep(for: .seconds(wait))
            guard !Task.isCancelled, reactionTask == nil, !isDragging,
                  Date().timeIntervalSince(lastInteraction) > 3 else { continue }
            if attention && pointNext {
                await run(.pointUp, direction: -1, jump: CGFloat(settings.jumpHeight), live: 1)
            } else {
                await runIdle(step.action)
            }
            pointNext.toggle()
            if !Task.isCancelled { await rest() }
        }
    }

    private func runIdle(_ action: FlameIdleAction) async {
        switch action {
        case .lookLeft:
            await pose(.easeInOut(duration: 0.3), hold: 0.8) { p in
                p.faceDX = -size * 0.022; p.rot = -2.5; p.dx = -3
            }
        case .lookRight:
            await pose(.easeInOut(duration: 0.3), hold: 0.8) { p in
                p.faceDX = size * 0.022; p.rot = 2.5; p.dx = 3
            }
        case .footTap:
            for i in 0..<3 where !Task.isCancelled {
                await pose(.easeInOut(duration: 0.1), hold: 0.12) { p in
                    p.legSR = i.isMultiple(of: 2) ? -30 : 0; p.dy = -1
                }
            }
        case .stretch:
            await pose(.easeInOut(duration: 0.35), hold: 0.7) { p in
                p.dy = -2; p.sx = 0.96; p.sy = 1.07; p.face = .sleepy
                p.armSL = 150; p.armSR = -150
            }
        case .miniHop:
            await hop(height: CGFloat(7 * settings.liveliness), face: .normal)
        case .wiggle:
            for rot in [-3.5, 3.5, -2.0] where !Task.isCancelled {
                await pose(.easeInOut(duration: 0.1), hold: 0.1) { p in
                    p.rot = rot; p.face = .happy; p.armSL = 18; p.armSR = -18
                }
            }
        }
    }

    private func updateMotion() {
        if gyroOn { motion.start() } else { motion.stop() }
    }
}

