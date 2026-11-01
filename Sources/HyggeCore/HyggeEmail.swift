import Foundation

/// Brief 04 @usehygge.cc identity (receive only).
///
/// The address is 10 random digits allocated by the backend, never
/// derived from the user's name or email. The app only ever sees
/// the signed-in user's own address (profile hub, for forwarding
/// setup) and summary-level filed mail. Emailed codes never reach
/// the device at all — they stay sealed in the user's server-side
/// inbox until a mission consumes them once.
public enum HyggeEmail {
    public static let domain = "usehygge.cc"
    public static let digitsCount = 10

    public static func digits(from address: String) -> String? {
        let value = HyggeAuth.normalizeEmail(address)
        guard value.hasSuffix("@\(domain)") else { return nil }
        let digits = String(value.dropLast(domain.count + 1))
        guard digits.count == digitsCount, digits.allSatisfy(\.isNumber) else { return nil }
        return digits
    }

    public static func isHyggeAddress(_ address: String) -> Bool {
        digits(from: address) != nil
    }

    public static func address(digits: String) -> String? {
        guard digits.count == digitsCount, digits.allSatisfy(\.isNumber) else { return nil }
        return "\(digits)@\(domain)"
    }

    /// Shown in the profile hub so the user can forward their own
    /// mail into the same filing pipeline. No external mailbox is
    /// ever auto-configured.
    public static let forwardingHelp = "Forward mail from gig sites to this address and Hygge will file it for you. Hygge can also use it when signing you up, so you never need to open your email."
}

/// The signed-in user's own Hygge address, as `GET /email/address`
/// reports it. No other user's address is representable here.
public struct HyggeEmailAddress: Codable, Equatable, Sendable {
    public var address: String
    public var digits: String
    public var createdAt: String
    public init(address: String, digits: String, createdAt: String) {
        self.address = address
        self.digits = digits
        self.createdAt = createdAt
    }
}

public struct HyggeEmailAddressResponse: Codable, Equatable, Sendable {
    public var hyggeEmail: HyggeEmailAddress?
    public init(hyggeEmail: HyggeEmailAddress?) { self.hyggeEmail = hyggeEmail }
}

/// Which email a site signup uses. This is about third-party site
/// accounts only — never the Hygge account login itself.
public enum SiteSignupEmailChoice: String, Codable, Equatable, Sendable {
    case hygge
    case own

    /// Draft keys carried into the approved signup task. With a
    /// Hygge address, Hygge watches the inbox and finishes email
    /// verification without the user opening email.
    public func draftedPayload(signupEmail: String, displayName: String) -> [String: String] {
        [
            "displayName": displayName,
            "email": HyggeAuth.normalizeEmail(signupEmail),
            "emailChoice": rawValue,
            "awaitingEmailVerification": self == .hygge ? "true" : "false",
        ]
    }
}

/// One filed mail summary from `GET /email/messages`. Summary-level
/// only: codes are redacted server-side, links arrive as plain
/// counts/hosts inside `actionableItems`, and attachment bodies
/// never leave the server (there is nothing to download here).
public struct FiledEmailSummary: Codable, Equatable, Sendable, Identifiable {
    public struct AttachmentMeta: Codable, Equatable, Sendable {
        public var filename: String
        public var contentType: String
        public var size: Int
        public init(filename: String, contentType: String, size: Int) {
            self.filename = filename
            self.contentType = contentType
            self.size = size
        }
    }

    public var id: String
    public var sender: String
    public var senderDomain: String
    public var subject: String
    public var date: String?
    public var kind: String
    public var summary: String
    public var actionableItems: [String]
    public var attachments: [AttachmentMeta]
    public var filedAt: String?

    public init(id: String, sender: String, senderDomain: String, subject: String,
                date: String? = nil, kind: String, summary: String,
                actionableItems: [String] = [], attachments: [AttachmentMeta] = [],
                filedAt: String? = nil) {
        self.id = id
        self.sender = sender
        self.senderDomain = senderDomain
        self.subject = subject
        self.date = date
        self.kind = kind
        self.summary = summary
        self.actionableItems = actionableItems
        self.attachments = attachments
        self.filedAt = filedAt
    }
}

/// Suggested SITE passwords for the own-email path. Generated on
/// the device at the moment of entry and sent once to the vault on
/// confirmation — never a Hygge-account password, never stored on
/// the device, never shown again after saving.
public enum SitePasswordSuggestion {
    public static let length = 20
    private static let lower = Array("abcdefghjkmnpqrstuvwxyz")
    private static let upper = Array("ABCDEFGHJKMNPQRSTUVWXYZ")
    private static let digitsPool = Array("23456789")
    private static let symbols = Array("!@#$%^&*-_=+")

    public static func generate() -> String {
        var rng = SystemRandomNumberGenerator()
        return generate(using: &rng)
    }

    public static func generate<R: RandomNumberGenerator>(using rng: inout R) -> String {
        let pools = [lower, upper, digitsPool, symbols]
        var chars = pools.compactMap { $0.randomElement(using: &rng) }
        let all = lower + upper + digitsPool + symbols
        while chars.count < length, let next = all.randomElement(using: &rng) {
            chars.append(next)
        }
        chars.shuffle(using: &rng)
        return String(chars)
    }

    public static func isStrong(_ value: String) -> Bool {
        value.count >= length
            && value.contains(where: \.isLowercase)
            && value.contains(where: \.isUppercase)
            && value.contains(where: \.isNumber)
            && value.contains { !$0.isLetter && !$0.isNumber }
    }
}
