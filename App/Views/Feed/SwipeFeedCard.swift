import SwiftUI
import UIKit

/// One horizontal interaction for every feed card: right swipe
/// always means "Chat about this" (the card rides into the
/// conversation as context), left swipe dismisses where allowed.
/// A card's own action buttons live in its opened detail, never
/// on the swipe. UIKit rejects vertical pans before recognition
/// so dragging a card vertically still scrolls the feed.
struct SwipeFeedCard<Content: View>: View {
    let id: String
    @Binding var openCardID: String?
    let open: () -> Void
    let chat: () -> Void
    let dismiss: () -> Void
    var allowsDismissal = true
    /// False when the card's action is gone (e.g. an expired
    /// decision): the rightward swipe never reveals chat, and no
    /// chat action is offered. Dismissal is unaffected.
    var allowsChat = true
    @ViewBuilder var content: Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var offset: CGFloat = 0
    @State private var origin: CGFloat = 0
    @State private var armed = false
    @State private var committing = false
    @State private var width: CGFloat = 1

    private var motion: Animation { reduceMotion ? .linear(duration: 0.12) : .spring(response: 0.32, dampingFraction: 0.82) }
    var body: some View {
        content
            .contentShape(RoundedRectangle(cornerRadius: 22))
            .overlay {
                FeedGestureSurface(onTap: tap, onBegin: beginDrag, onChange: drag, onEnd: endDrag)
                    .accessibilityHidden(true)
            }
            .offset(x: offset)
            .rotationEffect(.degrees(rotation))
            .background {
                FeedSwipeUnderlay(offset: offset, armed: armed,
                                  reduceMotion: reduceMotion,
                                  disabled: committing, commit: commit)
                    .accessibilityHidden(true)
                    .opacity(offset == 0 ? 0 : 1)
                    .background(GeometryReader { geometry in
                        Color.clear.onAppear { width = geometry.size.width }
                            .onChange(of: geometry.size.width) { _, value in width = value; close() }
                    })
            }
            .clipShape(RoundedRectangle(cornerRadius: 22))
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { open() }
            .accessibilityActions {
                if allowsChat { Button("Chat about this", action: chat) }
                if allowsDismissal { Button("Dismiss", action: dismiss) }
            }
            .accessibilityHint(allowsChat
                ? (allowsDismissal
                    ? "Opens details. Swipe right to chat about this, left to dismiss."
                    : "Opens details. Swipe right to chat about this.")
                : (allowsDismissal
                    ? "Opens details. Swipe left to dismiss."
                    : "Opens details."))
            .onChange(of: openCardID) { _, value in if value != id { close() } }
    }
    private var rotation: Double {
        guard !reduceMotion, offset < 0, width > 0 else { return 0 }
        return -min(2.0, Double(abs(offset) / width) * 2.0)
    }
    private func tap() {
        guard !committing else { return }
        if offset != 0 { close() } else { open() }
    }
    private func beginDrag() { origin = offset; openCardID = id }
    private func drag(_ translation: CGFloat) {
        guard !committing else { return }
        offset = min(allowsChat ? width : 0, max(allowsDismissal ? -width : 0, origin + translation))
        let next = Double(abs(offset)) >= FeedSwipe.threshold(width: Double(width))
        if next != armed {
            armed = next
            if next { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
        }
    }
    private func endDrag(_ cancelled: Bool) {
        guard !cancelled else { close(); return }
        switch FeedSwipe.outcome(offset: Double(offset), width: Double(width)) {
        case .closed: close()
        case .revealed(let direction):
            withAnimation(motion) { offset = CGFloat(direction) * CGFloat(FeedSwipe.revealWidth) }
        case .triggered(let direction): commit(direction)
        }
        armed = false
    }
    private func close() {
        withAnimation(motion) { offset = 0; armed = false }
    }
    private func commit(_ direction: Int) {
        guard !committing else { return }
        committing = true
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        withAnimation(motion) { offset = CGFloat(direction) * width }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(reduceMotion ? 120 : 220))
            guard !Task.isCancelled else { return }
            if direction > 0 { chat() } else { dismiss() }
            offset = 0; origin = 0; committing = false; openCardID = nil
        }
    }
}

private struct FeedSwipeUnderlay: View {
    let offset: CGFloat
    let armed: Bool
    let reduceMotion: Bool
    let disabled: Bool
    let commit: (Int) -> Void
    private var isChat: Bool { offset >= 0 }
    private var title: String {
        if armed { return isChat ? "Release to chat" : "Release to dismiss" }
        return isChat ? "Chat about this" : "Dismiss"
    }
    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: isChat ? .leading : .trailing) {
                (isChat ? HyggeTheme.sageDeep : HyggeTheme.ember)
                Button { commit(isChat ? 1 : -1) } label: {
                    VStack(spacing: 6) {
                        Image(systemName: isChat ? "bubble.left.fill" : "leaf")
                            .font(.system(size: 22, weight: .semibold))
                            .scaleEffect(armed && !reduceMotion ? 1.15 : 1)
                        Text(title).font(.system(.caption, design: .rounded, weight: .semibold))
                            .multilineTextAlignment(.center)
                    }
                    .foregroundStyle(isChat ? HyggeTheme.onSage : HyggeTheme.faceBrown)
                    .frame(width: max(CGFloat(FeedSwipe.revealWidth), abs(offset)), height: geometry.size.height)
                    .frame(width: max(0, abs(offset)), alignment: isChat ? .leading : .trailing)
                    .clipped().contentShape(Rectangle())
                }.buttonStyle(.plain).disabled(disabled || offset == 0)
            }
        }
    }
}

private struct FeedGestureSurface: UIViewRepresentable {
    var onTap: () -> Void
    var onBegin: () -> Void
    var onChange: (CGFloat) -> Void
    var onEnd: (Bool) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        let pan = UIPanGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.pan(_:)))
        pan.delegate = context.coordinator; pan.maximumNumberOfTouches = 1
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tap))
        tap.require(toFail: pan)
        view.addGestureRecognizer(pan); view.addGestureRecognizer(tap)
        return view
    }
    func updateUIView(_ view: UIView, context: Context) { context.coordinator.parent = self }
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var parent: FeedGestureSurface
        init(_ parent: FeedGestureSurface) { self.parent = parent }
        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
            let velocity = pan.velocity(in: pan.view)
            return abs(velocity.x) > abs(velocity.y) * 1.3
        }
        @objc func tap() { parent.onTap() }
        @objc func pan(_ recognizer: UIPanGestureRecognizer) {
            switch recognizer.state {
            case .began: parent.onBegin(); parent.onChange(recognizer.translation(in: nil).x)
            case .changed: parent.onChange(recognizer.translation(in: nil).x)
            case .ended: parent.onEnd(false)
            case .cancelled, .failed: parent.onEnd(true)
            default: break
            }
        }
    }
}
