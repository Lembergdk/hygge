import Foundation

/// Where a job site's own icon lives. Cards show the site's real
/// mark (loaded from the site itself — no third-party favicon
/// service), and fall back to a letter tile when a site offers
/// nothing usable. Order matters: the touch icon is the large,
/// app-icon-style artwork; favicon.ico is the last resort.
public enum SiteIcon {
    public static func candidateURLs(domain: String) -> [URL] {
        let host = normalizedHost(domain)
        guard !host.isEmpty, host.contains(".") else { return [] }
        return [
            URL(string: "https://\(host)/apple-touch-icon.png"),
            URL(string: "https://\(host)/favicon.ico"),
        ].compactMap { $0 }
    }

    /// Accepts a bare domain or a full URL string; returns the
    /// bare host without "www.".
    public static func normalizedHost(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let host: String
        if let url = URL(string: trimmed), let h = url.host {
            host = h
        } else {
            host = trimmed.split(separator: "/").first.map(String.init) ?? trimmed
        }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    /// The fallback letter for a site name (first alphanumeric,
    /// uppercased), or "?" when a name has none.
    public static func monogram(for name: String) -> String {
        guard let ch = name.first(where: { $0.isLetter || $0.isNumber }) else { return "?" }
        return String(ch).uppercased()
    }
}
