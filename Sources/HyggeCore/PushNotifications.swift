import Foundation

/// Brief 07 push routing contract, shared by the app shell and its
/// tests. The server payload carries a descriptive title + body
/// plus one reference (`hyggeRoute`): "task/<uuid>",
/// "chat/<uuid>", "feed/<uuid>", "email/<uuid>", or "home" — each
/// naming the exact element the tap opens. "chat" opens the bare
/// conversation (a chat message with no task, e.g. new work);
/// "feed" survives only for payloads already sent — nothing plans
/// a feed push anymore. Parsing lives here so the landing rules
/// are unit-tested without UIKit; anything unknown or malformed
/// lands on Home instead of failing.
public enum PushRoute: Equatable, Sendable {
    case task(UUID)
    case chat(UUID)
    case feedItem(UUID)
    case email(UUID)
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
        case "chat": return .chat(id)
        case "feed": return .feedItem(id)
        case "email": return .email(id)
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
        case "chat": return .chat(id)
        case "feed": return .feedItem(id)
        case "email": return .email(id)
        default: break
        }
        if kind == "new_work" { return .feedItem(id) }
        if kind == "message_waiting" { return .email(id) }
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

/// The one permission ask (Brief 07): onboarding asks alongside
/// calendar, with the reason stated first. This primer is only
/// the second chance for people who skipped that undecided — it
/// appears only after the first thing worth telling the user
/// about exists, only while the system answer is still
/// undecided, and only once. After an answer either place it
/// never shows again — turning notifications back on is a
/// Settings visit from the profile hub, never another in-app ask.
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
