import Foundation

/// Identity rules shared by the app (Brief 00): one durable account,
/// Apple or email/password methods, interchangeable once explicitly
/// linked. The backend enforces these; the app mirrors them so the UI
/// never offers something the account cannot do.
public enum HyggeAuth {
    public static let passwordMinLength = 10

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

    /// Nil when acceptable; otherwise the plain-language problem.
    public static func passwordProblem(_ password: String) -> String? {
        password.count >= passwordMinLength
            ? nil
            : "Use at least \(passwordMinLength) characters for your password."
    }

    /// An account is never orphaned: its last login method stays.
    public static func canRemoveLoginMethod(methodCount: Int) -> Bool {
        methodCount > 1
    }
}

/// One linked way into an account, as the backend reports it. Carries
/// no secret material (no password hash, no Apple subject id).
public struct LinkedLoginMethod: Codable, Identifiable, Equatable {
    public enum Kind: String, Codable {
        case apple
        case email

        public var label: String {
            switch self {
            case .apple: return "Apple"
            case .email: return "Email and password"
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

/// Where launch routing lands (carousel -> sign-in -> onboarding ->
/// home). Pure so every branch is testable without a simulator.
public enum AuthGateScreen: Equatable {
    case carousel
    case auth
    case onboarding
    case home
}

public enum AuthGate {
    public static func resolve(hasSeenCarousel: Bool, hasOnboarded: Bool,
                               isSignedIn: Bool, authRequired: Bool) -> AuthGateScreen {
        if !hasOnboarded && !hasSeenCarousel { return .carousel }
        if authRequired && !isSignedIn { return .auth }
        return hasOnboarded ? .home : .onboarding
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
