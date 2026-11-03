import Foundation

/// Distance, rather than velocity, decides whether releasing a card commits.
/// The same policy drives the visible threshold and the release action.
public enum FeedSwipe {
    public enum Outcome: Equatable { case closed, revealed(Int), triggered(Int) }
    public static let revealWidth: Double = 92
    public static func threshold(width: Double) -> Double { max(160, width * 0.62) }
    public static func outcome(offset: Double, width: Double) -> Outcome {
        guard width > 0, offset.isFinite else { return .closed }
        let direction = offset >= 0 ? 1 : -1
        if abs(offset) >= threshold(width: width) { return .triggered(direction) }
        if abs(offset) >= 32 { return .revealed(direction) }
        return .closed
    }
}
