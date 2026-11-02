import Foundation

/// Brief 07 push routing contract, shared by the app shell and its
/// tests. The server payload can only carry a calm title plus one
/// reference (`hyggeRoute`): "task/<uuid>", "feed/<uuid>", or
/// "home". Parsing lives here so the landing rules are unit-tested
/// without UIKit; anything unknown or malformed lands on Home —
/// the app's only destination — instead of failing.
public enum PushRoute: Equatable, Sendable {
    case task(UUID)
    case feedItem(UUID)
    case home
}

public enum PushDeepLink {
    /// Parse the `hyggeRoute` string the server sends. Ids are
    /// compared case-insensitively via UUID, matching how server
    /// feed/task ids are stored.
    public static func parse(route: String?) -> PushRoute {
        guard let route else { return .home }
        let parts = route.split(separator: "/", maxSplits: 1).map(String.init)
        guard parts.count == 2, let id = UUID(uuidString: parts[1]) else { return .home }
        switch parts[0] {
        case "task": return .task(id)
        case "feed": return .feedItem(id)
        default: return .home
        }
    }

    /// Fallback shape: kind + bare reference, for payloads without a
    /// route string. A needs-you reference without a kind prefix is
    /// ambiguous (task vs feed item), so it is not guessed at.
    public static func parse(kind: String?, ref: String?, refKind: String?) -> PushRoute {
        guard let ref, let id = UUID(uuidString: ref) else { return .home }
        switch refKind {
        case "task": return .task(id)
        case "feed": return .feedItem(id)
        default: break
        }
        if kind == "new_work" { return .feedItem(id) }
        return .home
    }
}

/// APNs hands the app raw token bytes; the registration API takes
/// lowercase hex (the server rejects anything else).
public enum DeviceTokenEncoding {
    public static func hexString(from data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    /// Same plausibility rule the server enforces, so the app never
    /// uploads a token registration would only reject.
    public static func isPlausible(_ token: String) -> Bool {
        let trimmed = token.trimmingCharacters(in: .whitespaces).lowercased()
        guard (32...256).contains(trimmed.count) else { return false }
        return trimmed.allSatisfy { $0.isHexDigit }
    }
}

/// The one permission ask (Brief 07): an inline primer appears
/// only after the first thing worth telling the user about exists,
/// only while the system answer is still undecided, and only once.
/// After a "not now" or a system denial it never shows again —
/// turning notifications back on is a Settings visit from the
/// profile hub, never another in-app ask.
public enum NotificationAuthorizationKind: Equatable, Sendable {
    case notDetermined
    case authorized
    case denied
}

public enum NotificationPrimerPolicy {
    public static func shouldShowPrimer(hasNotifiableEvent: Bool,
                                        primerAlreadyResolved: Bool,
                                        authorization: NotificationAuthorizationKind,
                                        isSignedIn: Bool) -> Bool {
        hasNotifiableEvent
            && !primerAlreadyResolved
            && authorization == .notDetermined
            && isSignedIn
    }
}
