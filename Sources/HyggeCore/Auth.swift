import Foundation

/// Identity rules shared by the app: one durable account, Apple or
/// email magic-link methods, interchangeable once explicitly linked.
/// There is no Hygge-account password. The backend enforces these;
/// the app mirrors them so the UI never offers something the account
/// cannot do.
public enum HyggeAuth {
    /// Login emails are matched case-insensitively everywhere.
    public static func normalizeEmail(_ email: String) -> String {
        email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    public static func isPlausibleEmail(_ email: String) -> Bool {
        let value = normalizeEmail(email)
        guard value.count <= 254, !value.contains(" ") else { return false }
        let parts = value.split(separator: "@")
        return parts.count == 2 && !parts[0].isEmpty && parts[1].contains(".") && !parts[1].hasPrefix(".") && !parts[1].hasSuffix(".")
    }

    /// A Sign in with Apple relay address is opaque contact data only:
    /// it must never be used to match, merge, or contact-verify an
    /// account.
    public static func isPrivateRelayEmail(_ email: String?) -> Bool {
        guard let email else { return false }
        return normalizeEmail(email).hasSuffix("@privaterelay.appleid.com")
    }

    /// An account is never orphaned: its last login method stays.
    public static func canRemoveLoginMethod(methodCount: Int) -> Bool {
        methodCount > 1
    }
}

/// Magic-link URLs arrive two ways: the https universal link on the
/// API host, and the hygge:// link from the landing page. Anything
/// else — wrong host, wrong path, missing token — is not a sign-in
/// link and is ignored. Tokens are never logged.
public enum MagicLink {
    public static let appHosts: Set<String> = ["api.usehygge.app", "api-staging.usehygge.app"]

    public static func token(from url: URL) -> String? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        switch components.scheme?.lowercased() {
        case "https":
            guard let host = components.host?.lowercased(), appHosts.contains(host),
                  components.path == "/auth/magic" else { return nil }
        case "hygge":
            guard components.host?.lowercased() == "auth", components.path == "/magic" else { return nil }
        default:
            return nil
        }
        let token = components.queryItems?.first(where: { $0.name == "token" })?.value?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let token, !token.isEmpty else { return nil }
        return token
    }

    public static func isMagicLink(_ url: URL) -> Bool { token(from: url) != nil }
}

/// One linked way into an account, as the backend reports it. Carries
/// no secret material (no token material, no Apple subject id).
public struct LinkedLoginMethod: Codable, Identifiable, Equatable {
    public enum Kind: String, Codable {
        case apple
        case email

        public var label: String {
            switch self {
            case .apple: return "Apple"
            case .email: return "Email"
            }
        }
    }

    public var id: String
    public var method: Kind
    public var email: String?
    public var emailVerified: Bool

    public init(id: String, method: Kind, email: String? = nil, emailVerified: Bool = false) {
        self.id = id
        self.method = method
        self.email = email
        self.emailVerified = emailVerified
    }
}

/// Where launch routing lands: carousel -> onboarding conversation
/// (sign-in is its final step) -> home. There is no standalone
/// sign-in screen: `.signIn` is the onboarding conversation showing
/// only its sign-in message, for returning users. Pure so every
/// branch is testable without a simulator.
public enum AuthGateScreen: Equatable {
    case carousel
    case onboarding
    /// Returning user who asked to sign in: the sign-in message alone.
    case signIn
    case home
}

public enum AuthGate {
    public static func resolve(hasSeenCarousel: Bool, hasOnboarded: Bool,
                               isSignedIn: Bool, authRequired: Bool,
                               wantsSignIn: Bool = false) -> AuthGateScreen {
        if !hasOnboarded && !hasSeenCarousel { return .carousel }
        // A signed-out returning user who asked to sign in sees the
        // sign-in message alone, not the whole conversation again.
        if authRequired && !isSignedIn && wantsSignIn { return .signIn }
        if hasOnboarded {
            // Home needs a live session when cloud is required; until
            // then the path back is the same sign-in message.
            return (isSignedIn || !authRequired) ? .home : .signIn
        }
        return .onboarding
    }
}

/// What to do right after a successful sign-in, decided from facts
/// the store can check: whether the signed-in account already has
/// server state, whether that state is onboarded, and whether this
/// device just finished the onboarding questions locally.
public enum SignInCompletion: Equatable {
    /// The account is onboarded on the server: adopt its state and
    /// go Home. The local snapshot must never be imported over it.
    case adoptServerState
    /// Fresh (or not-yet-onboarded) account + finished local answers:
    /// complete onboarding with them and import once.
    case completeOnboardingAndImport
    /// Fresh account, questions not finished: keep asking.
    case continueOnboarding

    public static func decide(serverHasState: Bool, serverHasOnboarded: Bool,
                              localProfileComplete: Bool) -> SignInCompletion {
        if serverHasState && serverHasOnboarded { return .adoptServerState }
        if localProfileComplete { return .completeOnboardingAndImport }
        return .continueOnboarding
    }
}

/// Session tokens live in the Keychain, never UserDefaults. Tokens
/// stored by older builds are migrated once (unless they belong to
/// the retired local backend pair, which is dropped instead).
public enum SessionTokenStorage {
    public static let keychainService = "app.usehygge"
    public static let keychainAccount = "backendToken"
    public static let legacyUserDefaultsKey = "backendToken"

    public static func shouldMigrateLegacyToken(storedToken: String?, storedBaseURL: String?) -> Bool {
        guard let storedToken, !storedToken.isEmpty else { return false }
        return !BackendAddress.isStaleLocal(stored: storedBaseURL)
    }
}
