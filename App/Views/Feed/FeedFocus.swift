import SwiftUI

enum FeedFocus: Identifiable {
    case proposal(ProposedSite), opportunity(Opportunity), event(ActivityEvent), task(AgentTask), browser(AgentTask), paused, emailDecision(FiledEmailSummary)
    var id: String {
        switch self {
        case .proposal(let value): return "proposal-\(value.id)"
        case .opportunity(let value): return "opportunity-\(value.id)"
        case .event(let value): return "event-\(value.id)"
        case .task(let value), .browser(let value): return Self.taskKey(value)
        case .paused: return "paused"
        case .emailDecision(let value): return "email-decision-\(value.senderDomain)"
        }
    }
    var maximumHeight: CGFloat {
        switch self {
        case .paused: return 320
        case .event, .emailDecision: return 560
        case .proposal: return 600
        case .opportunity, .task: return 680
        case .browser: return 780
        }
    }
    static func taskKey(_ task: AgentTask) -> String {
        if task.isActiveInFeed { return "task-live-\(task.id)" }
        return "task-\(task.id)-\(task.status.rawValue)-\(task.help?.id.uuidString ?? "")"
    }
}

/// The selected object becomes a floating card over its own feed context.
/// There is no sheet presentation or bottom-edge slide in this interaction.
/// Dismissal follows the app-wide handle pattern (see the chat bubble):
/// drag the grabber down — the card follows, past the threshold it
/// returns to its feed row, short of that it springs back. Tapping the
/// grabber, tapping the backdrop, and VoiceOver escape are the
/// non-drag paths; there is no "Back to feed" button.
struct FeedFocusCard<Content: View>: View {
    let close: () -> Void
    @ViewBuilder var content: Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dragOffset: CGFloat = 0
    var body: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .top) {
                Color.clear
                Capsule()
                    .fill(HyggeTheme.secondary.opacity(0.55))
                    .frame(width: 38, height: 5)
                    .padding(.top, 8)
            }
            .frame(width: 160, height: 32)
            .contentShape(Rectangle())
            .highPriorityGesture(
                DragGesture(minimumDistance: 4)
                    .onChanged { value in
                        dragOffset = max(0, value.translation.height)
                    }
                    .onEnded { value in
                        if value.translation.height > 90
                            || value.predictedEndTranslation.height > 200 {
                            close()
                        } else {
                            withAnimation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.85)) {
                                dragOffset = 0
                            }
                        }
                    }
            )
            .onTapGesture { close() }
            .accessibilityElement()
            .accessibilityLabel("Back to feed")
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("feedFocusGrabber")
            .accessibilityAction { close() }
            content
        }
        .offset(y: dragOffset)
        .background(HyggeTheme.card)
        .clipShape(RoundedRectangle(cornerRadius: 28))
        .overlay(RoundedRectangle(cornerRadius: 28).stroke(HyggeTheme.hairline, lineWidth: 1))
        .shadow(color: .black.opacity(0.35), radius: 30, y: 12)
        .accessibilityAction(.escape, close)
    }
}
