import Foundation

/// Which backend address the app should actually use. Builds from
/// the retired local-backend era may still carry a stored LAN or
/// loopback `http://` override in settings; those point at a service
/// that no longer exists, so they are ignored in favour of the
/// build's cloud default. A real https override is respected.
public enum BackendAddress {
    public static func effective(stored: String?, fallback: String) -> String {
        guard let stored, !stored.isEmpty, let url = URL(string: stored),
              let scheme = url.scheme?.lowercased(), scheme == "https" else {
            return fallback
        }
        return stored
    }

    /// True when a stored override points at the retired local
    /// backend (plain http). The token stored alongside such a URL
    /// belongs to that dead service too, so callers can drop the pair.
    public static func isStaleLocal(stored: String?) -> Bool {
        guard let stored, !stored.isEmpty, let url = URL(string: stored),
              let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "http"
    }
}
