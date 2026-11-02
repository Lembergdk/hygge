import Foundation

/// Only complete, finite, nonnegative decimal inputs can replace the saved
/// rate. Empty/partial/malformed typing must not silently turn the floor to 0.
public enum ProfileRateInput {
    public static func parse(_ value: String, locale: Locale = .current) -> Double? {
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .decimal
        let separator = formatter.decimalSeparator ?? "."
        let text = value.trimmingCharacters(in: .whitespaces)
        let parts = text.components(separatedBy: separator)
        guard !text.isEmpty, parts.count <= 2,
              parts.allSatisfy({ $0.unicodeScalars.allSatisfy(CharacterSet.decimalDigits.contains) }),
              text.unicodeScalars.contains(where: CharacterSet.decimalDigits.contains),
              !text.hasSuffix(separator),
              let result = formatter.number(from: text)?.doubleValue,
              result.isFinite, result >= 0 else { return nil }
        return result
    }
}
