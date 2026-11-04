import SwiftUI

/// The living flame: a layered rig (RiggedFlame) driven by a performance
/// engine, gyro lean, idle life, drag-anywhere carrying with flailing
/// limbs, twirl-until-nauseous, and the explorable gesture vocabulary.
/// Every reaction is a little scene — face, arms, legs and body together —
/// with tap/press scenes remappable in Flame Lab and unified touch physics.
struct FlameActor: View {
    var size: CGFloat
    var clipOverride: FlameAnimation? = nil
    var attention = false
    /// A live browser session: the laptop comes out, typing replaces
    /// every idle behavior, and gestures play with the laptop up.
    var browsing = false
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
    @State private var laptopOn = false
    @State private var typingTap: Int = 0
    @State private var pinchScale: CGFloat = 1
    @GestureState private var touchIsDown = false
    @State private var touchPhysics = FlameTouchPhysics()
    @State private var touchTask: Task<Void, Never>?
    @State private var touchFrame = CGRect.zero
    @State private var touchStartedAt = 0.0
    @State private var pinching = false
    @State private var isDragging = false
    @State private var spinAccum: Double = 0
    @State private var lastDragAngle: Double?
    @State private var pendingNausea = false
    @State private var travelTask: Task<Void, Never>?
    @State private var reactionTask: Task<Void, Never>?
    @State private var pendingTapTask: Task<Void, Never>?
    @State private var idlePlanner = FlameIdlePlanner()
    @State private var lastInteraction = Date()
    @State private var lastPinchEnd = Date.distantPast
    @State private var longPressFired = false
    @State private var lastTapAt: Date?
    @State private var tapIsSecond = false

    private var settings: FlameInteractionSettings { playStore.settings }
    private var height: CGFloat { size * 1.25 }

    private var gyroOn: Bool {
        settings.gyroEnabled && !reduceMotion && scenePhase == .active
    }

    private var tilt: FlameTilt {
        guard !reduceMotion else { return .zero }
        guard !touchPhysics.isActive else { return .zero }
        return settings.gyroEnabled ? motion.tilt : .zero
    }

    var body: some View {
        RiggedFlame(pose: pose, size: size,
                    walking: walkCycle && !reduceMotion,
                    clipOverride: clipOverride,
                    laptop: laptopOn, typingTap: typingTap, touch: touchPhysics)
            .scaleEffect(x: breathing && !reduceMotion ? 0.995 : 1,
                         y: breathing && !reduceMotion ? 1.02 : 1, anchor: .bottom)
            .animation(.easeInOut(duration: 1.7).repeatForever(autoreverses: true),
                       value: breathing)
            .scaleEffect(pinchScale, anchor: .bottom)
            .rotationEffect(.degrees(-tilt.x * settings.gyroLeanDegrees), anchor: .bottom)
            .offset(x: tilt.x * 8 * settings.liveliness + touchOffset.width,
                    y: tilt.y * 5 + touchOffset.height)
            .frame(width: size, height: height)
            .contentShape(Rectangle())
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { touchFrame = $0 }
            .onChange(of: touchIsDown) { _, down in
                if !down, touchPhysics.isHeld { cancelTouch() }
            }
            .simultaneousGesture(dragGesture, including: interactive ? .gesture : .none)
            .simultaneousGesture(pinchGesture, including: interactive ? .gesture : .none)
            .simultaneousGesture(longPressGesture,
                                 including: interactive ? .gesture : .none)
            .onAppear {
                breathing = true
                var instant = Transaction()
                instant.disablesAnimations = true
                withTransaction(instant) { laptopOn = browsing }
                updateMotion()
            }
            .onChange(of: browsing) { _, now in
                laptopOn = now
                if !now { typingTap = 0 }
            }
            .onDisappear {
                cancelTouch()
                motion.stop(); reactionTask?.cancel(); pendingTapTask?.cancel()
                travelTask?.cancel()
            }
            .onChange(of: traveling) { _, now in
                if now {
                    cancelTouch()
                    startTravelHops()
                } else {
                    // Land the moment he arrives instead of finishing
                    // whichever airborne pose was mid-hold.
                    travelTask?.cancel()
                    travelTask = nil
                    Task { @MainActor in await rest() }
                }
            }
            .onChange(of: scenePhase) {
                if scenePhase != .active { cancelTouch() }
                updateMotion()
            }
            .onChange(of: reduceMotion) { cancelTouch(); updateMotion() }
            .onChange(of: settings.gyroEnabled) { updateMotion() }
            .onChange(of: motion.shakeCount) {
                if interactive { fire(.shake, direction: 0, intensity: 1) }
            }
            .onChange(of: preview) { _, request in
                if let request { perform(request.reaction, direction: 1, intensity: 1) }
            }
            .task(id: IdleKey(active: idleLoopActive, browsing: browsing)) { await runIdleLoop() }
    }

    private var idleLoopActive: Bool {
        settings.idleEnabled && !reduceMotion && scenePhase == .active
    }

    private struct IdleKey: Equatable { var active: Bool; var browsing: Bool }

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

    private var touchScale: Double { Double(size) / FlameTouchPhysics.referenceSize }
    private var touchOffset: CGSize {
        CGSize(width: touchPhysics.body.x * touchScale, height: touchPhysics.body.y * touchScale)
    }

    private func beginTouch(_ value: DragGesture.Value) {
        touchTask?.cancel()
        reactionTask?.cancel(); reactionTask = nil
        pendingTapTask?.cancel()
        tapIsSecond = FlameGestureClassifier.isDoubleTap(
            previousAt: lastTapAt?.timeIntervalSinceReferenceDate,
            now: Date().timeIntervalSinceReferenceDate)
        touchStartedAt = ProcessInfo.processInfo.systemUptime
        let point = FlamePoint(
            x: Double(value.startLocation.x - touchFrame.minX) / touchScale - 106.75,
            y: Double(value.startLocation.y - touchFrame.minY) / touchScale - 134.1666667)
        touchPhysics.begin(at: point, movable: movable, reduceMotion: reduceMotion)
        pose = .rest
        spinAccum = 0; lastDragAngle = nil; pendingNausea = false
        startTouchFrames()
    }

    /// Drive the spring on frames, including after release and while a
    /// stationary finger waits for pickup. Gesture events only supply input.
    private func startTouchFrames() {
        touchTask?.cancel()
        touchTask = Task { @MainActor in
            var previous = ProcessInfo.processInfo.systemUptime
            while !Task.isCancelled, touchPhysics.isActive, scenePhase == .active {
                let now = ProcessInfo.processInfo.systemUptime
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    let wasCarrying = touchPhysics.phase == .carrying
                    touchPhysics.advance(by: now - previous)
                    if !wasCarrying, touchPhysics.phase == .carrying {
                        isDragging = true
                        onDragBegan?()
                    }
                }
                previous = now
                do { try await Task.sleep(for: .milliseconds(16)) }
                catch { return }
            }
        }
    }

    private func cancelTouch() {
        let wasCarrying = isDragging
        touchTask?.cancel(); touchTask = nil
        touchPhysics.cancel()
        isDragging = false
        if wasCarrying { onDragEnded?(nil) }
    }

    // MARK: - Gestures

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .global)
            .updating($touchIsDown) { _, state, _ in state = true }
            .onChanged { value in
                lastInteraction = Date()
                guard !traveling, !pinching, !longPressFired,
                      Date().timeIntervalSince(lastPinchEnd) > 0.3 else { return }
                if !touchPhysics.isHeld { beginTouch(value) }
                let translation = FlamePoint(x: Double(value.translation.width) / touchScale,
                                             y: Double(value.translation.height) / touchScale)
                touchPhysics.move(to: translation,
                                  at: ProcessInfo.processInfo.systemUptime - touchStartedAt)
                if touchPhysics.phase == .carrying { trackSpin(value.location) }
            }
            .onEnded { value in
                lastInteraction = Date()
                if longPressFired { longPressFired = false; return }
                guard touchPhysics.isHeld else { return }
                let time = ProcessInfo.processInfo.systemUptime - touchStartedAt
                touchPhysics.move(to: FlamePoint(x: Double(value.translation.width) / touchScale,
                                                y: Double(value.translation.height) / touchScale), at: time)
                let wasCarrying = touchPhysics.phase == .carrying
                let moved = touchPhysics.travel > 5
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    let committed = touchPhysics.release(at: time)
                    isDragging = false
                    if wasCarrying {
                        onDragEnded?(committed.map {
                            CGSize(width: $0.x * touchScale, height: $0.y * touchScale)
                        })
                    }
                }
                if wasCarrying {
                    if pendingNausea { perform(.nauseous, direction: 0, intensity: 1.2) }
                    return
                }
                // A short swipe is the spring's continued stretch, never
                // a second hop/jump scene or a placement change.
                if moved {
                    let x = value.translation.width, y = value.translation.height
                    let gesture: FlameGestureKind = abs(x) >= abs(y)
                        ? (x < 0 ? .swipeLeft : .swipeRight)
                        : (y < 0 ? .swipeUp : .swipeDown)
                    onGesture?(gesture, .stretch)
                    return
                }
                guard Date().timeIntervalSince(lastPinchEnd) > 0.3 else { return }
                let local = value.startLocation
                let kind = FlameGestureClassifier.classify(
                    translationX: Double(value.translation.width),
                    translationY: Double(value.translation.height),
                    predictedX: Double(value.translation.width),
                    predictedY: Double(value.translation.height),
                    tapNormalizedY: height > 0 ? Double((local.y - touchFrame.minY) / height) : 0.5)
                guard let kind else { return }
                let direction: CGFloat = local.x - touchFrame.minX < size * 0.5 ? 1 : -1
                if tapIsSecond {
                    lastTapAt = nil
                    pendingTapTask?.cancel()
                    fire(.doubleTap, direction: direction, intensity: 1.15)
                } else {
                    lastTapAt = Date()
                    if onTap == nil { fire(kind, direction: direction, intensity: 1) }
                    scheduleTap()
                }
            }
    }

    private func trackSpin(_ location: CGPoint) {
        let center = CGPoint(x: touchFrame.midX, y: touchFrame.midY)
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

    private var pinchGesture: some Gesture {
        MagnifyGesture()
            .onChanged { value in
                lastInteraction = Date()
                if !pinching { cancelTouch(); pinching = true }
                pinchScale = min(1.6, max(0.6, value.magnification))
            }
            .onEnded { value in
                lastInteraction = Date()
                pinching = false
                lastPinchEnd = Date()
                withAnimation(.spring(response: 0.35, dampingFraction: 0.65)) { pinchScale = 1 }
                if value.magnification < 0.82 { fire(.pinchIn, direction: 0, intensity: 1) }
                else if value.magnification > 1.18 { fire(.pinchOut, direction: 0, intensity: 1) }
            }
    }

    private var longPressGesture: some Gesture {
        LongPressGesture(minimumDuration: 0.6, maximumDistance: 12)
            .onEnded { _ in
                guard !traveling, !isDragging, touchPhysics.travel <= 5 else { return }
                cancelTouch()
                longPressFired = true
                lastInteraction = Date()
                fire(.longPress, direction: 0, intensity: 1)
                onLongPress?()
            }
    }

    private func scheduleTap() {
        guard let onTap else { return }
        pendingTapTask?.cancel()
        pendingTapTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(160))
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
        guard !reduceMotion, reaction != .none, !touchPhysics.isHeld else { return }
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
                p.faceDX = -size * 0.020; p.faceDY = -size * 0.014
            }
            await hop(height: jump * 0.55, face: .laugh)
            await pose(.easeInOut(duration: 0.18), hold: 0.35) { p in
                p.face = .happy; p.armSL = 148; p.armSR = -24; p.rot = -3
                p.faceDX = -size * 0.020; p.faceDY = -size * 0.014
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

    /// The laptop clip, recreated on the rig: seated bob, eyes scanning
    /// lines on the unseen screen, stick arms tapping alternately every
    /// quarter second (the clip tapped every 6 frames at 24fps), then a
    /// glance up before the next round.
    private func runTyping() async {
        let scan = size * 0.020
        for i in 0..<10 where !Task.isCancelled {
            typingTap = i.isMultiple(of: 2) ? -1 : 1
            let sweep = -scan + 2 * scan * Double(i) / 9
            await pose(.easeInOut(duration: 0.22), hold: 0.25) { p in
                p.dy = i.isMultiple(of: 2) ? 0 : -1.5
                p.faceDX = sweep
                p.faceDY = size * 0.011
            }
        }
        typingTap = 0
        await pose(.easeOut(duration: 0.25), hold: 0.5) { p in
            p.face = .happy
        }
    }

    private func runIdleLoop() async {
        try? await Task.sleep(for: .seconds(browsing ? 0.6 : 2.5))
        while !Task.isCancelled {
            if attention {
                // A badge is showing: the only idle move is pointing
                // and looking up at it (badge sits top-left of him).
                guard !Task.isCancelled, reactionTask == nil, !touchPhysics.isActive,
                      Date().timeIntervalSince(lastInteraction) > 1.2 else {
                    try? await Task.sleep(for: .seconds(0.3))
                    continue
                }
                await run(.pointUp, direction: -1,
                          jump: CGFloat(settings.jumpHeight), live: 1)
                if !Task.isCancelled { await rest() }
                let pause = max(1.4, settings.idleInterval * 0.45
                                / max(0.5, settings.liveliness))
                try? await Task.sleep(for: .seconds(pause))
                continue
            }
            if browsing {
                // A live session overrides all idle life: he types.
                guard !Task.isCancelled, reactionTask == nil, !touchPhysics.isActive,
                      Date().timeIntervalSince(lastInteraction) > 0.8 else {
                    try? await Task.sleep(for: .seconds(0.3))
                    continue
                }
                await runTyping()
                if !Task.isCancelled { await rest() }
                try? await Task.sleep(for: .seconds(0.5))
                continue
            }
            let step = idlePlanner.next()
            let wait = settings.idleInterval * step.delayFactor / max(0.5, settings.liveliness)
            try? await Task.sleep(for: .seconds(wait))
            guard !Task.isCancelled, reactionTask == nil, !touchPhysics.isActive,
                  Date().timeIntervalSince(lastInteraction) > 3 else { continue }
            await runIdle(step.action)
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
        case .wave:
            await run(.wave, direction: 1, jump: CGFloat(settings.jumpHeight), live: 1)
        case .laugh:
            await run(.laugh, direction: 0, jump: CGFloat(settings.jumpHeight), live: 1)
        case .pointUp:
            await run(.pointUp, direction: -1, jump: CGFloat(settings.jumpHeight), live: 1)
        case .walkAbout:
            await run(.walkAbout, direction: Bool.random() ? 1 : -1,
                      jump: CGFloat(settings.jumpHeight), live: 1)
        case .turnAround:
            await run(.turnAround, direction: 0, jump: CGFloat(settings.jumpHeight), live: 1)
        case .yawn:
            await pose(.easeInOut(duration: 0.5), hold: 1.0) { p in
                p.face = .sleepy; p.sx = 0.97; p.sy = 1.06; p.dy = -2
                p.armSL = 132; p.armSR = -118
            }
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

