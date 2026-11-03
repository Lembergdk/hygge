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
struct FeedFocusCard<Content: View>: View {
    let close: () -> Void
    @ViewBuilder var content: Content
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button(action: close) {
                    Label("Back to feed", systemImage: "arrow.down.right.and.arrow.up.left")
                        .font(.subheadline.weight(.medium)).foregroundStyle(HyggeTheme.sageDeep).frame(minHeight: 44)
                }.buttonStyle(.plain)
                Spacer()
            }.padding(.horizontal, 22).padding(.top, 8)
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 20).onEnded { value in
                    if value.translation.height > 60 { close() }
                })
            content
        }
        .background(HyggeTheme.card)
        .clipShape(RoundedRectangle(cornerRadius: 28))
        .overlay(RoundedRectangle(cornerRadius: 28).stroke(HyggeTheme.hairline, lineWidth: 1))
        .shadow(color: .black.opacity(0.35), radius: 30, y: 12)
        .accessibilityAction(.escape, close)
    }
}
