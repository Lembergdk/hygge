import Foundation

/// One bounded recovery budget per interruption. A brief frame followed by another
/// disconnect must not reset it and leave the person watching an endless spinner.
public struct BrowserStreamRecovery {
    public enum Outcome: Equatable { case retry, unavailable, ended, signInRequired }
    public private(set) var failures = 0
    private var responsiveSince: Date?
    public init() {}

    public mutating func receivedResponse(at now: Date) {
        if responsiveSince == nil { responsiveSince = now }
        if now.timeIntervalSince(responsiveSince!) >= 30 { failures = 0 }
    }

    public mutating func disconnected(httpStatus: Int?, normallyClosed: Bool = false) -> Outcome {
        responsiveSince = nil
        if httpStatus == 401 || httpStatus == 403 { return .signInRequired }
        if httpStatus == 404 || httpStatus == 410 || normallyClosed { return .ended }
        failures += 1
        return failures < 3 ? .retry : .unavailable
    }
}
