import Foundation

/// ISO-8601 date parsing that accepts fractional seconds.
///
/// The backend writes timestamps with JavaScript's `toISOString()`,
/// which always includes fractional seconds
/// (`2026-10-31T10:05:00.000Z`). Foundation's plain `.iso8601`
/// decoding strategy rejects fractional seconds on older OS
/// releases, so server dates must go through this tolerant parser:
/// try fractional first, then plain internet date-time.
public enum HyggeISO8601 {
    public static func date(from string: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: string) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: string)
    }

    public static var dateDecodingStrategy: JSONDecoder.DateDecodingStrategy {
        .custom { decoder in
            let container = try decoder.singleValueContainer()
            let string = try container.decode(String.self)
            guard let date = date(from: string) else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "Expected ISO8601-formatted date string.")
            }
            return date
        }
    }
}
