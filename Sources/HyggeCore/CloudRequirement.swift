import Foundation

/// Whether this build must reach the cloud backend, or may fall back
/// to the on-device simulated runner when the backend is unreachable.
///
/// Source of truth is the `HYGGE_REQUIRE_CLOUD` Info.plist key (set
/// from the HYGGE_REQUIRE_CLOUD build setting: NO in Debug, YES in
/// Release). When the key is absent, Debug builds default to
/// optional and Release builds to required — a release build must
/// never silently simulate work.
public enum CloudRequirement {
    public static func resolve(infoPlistValue: String?, isDebugBuild: Bool) -> Bool {
        switch infoPlistValue?.trimmingCharacters(in: .whitespaces).uppercased() {
        case "YES", "TRUE", "1": return true
        case "NO", "FALSE", "0": return false
        default: return !isDebugBuild
        }
    }

    /// Local simulated execution is allowed only when cloud is not required.
    public static func mayRunLocally(requireCloud: Bool) -> Bool {
        !requireCloud
    }
}
