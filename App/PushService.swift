import Foundation
import UIKit
import UserNotifications

/// Brief 07: the bridge between UIKit's push callbacks and the
/// store. The app delegate can fire before the store exists (cold
/// launch from a tap), so arrivals are held here and drained by
/// AppStore.refreshPushState() at launch, on foregrounding, and
/// after sign-in. Nothing is written to disk here; the store owns
/// registration, and the token is uploaded once per refresh.
enum PushInbox {
    static var pendingTokenHex: String?
    static var pendingRoute: String?
    /// Token of the most recent delivery. Duplicate deliveries of the
    /// same token must not re-trigger a refresh (see receive).
    static var lastDeliveredTokenHex: String?
    /// Set once by AppStore so a token or tap that arrives while the
    /// app is already running is handled straight away.
    static var onArrival: (@MainActor () -> Void)?

    @MainActor
    static func receive(tokenHex: String) {
        // iOS re-delivers the current token on every
        // registerForRemoteNotifications call, and refreshPushState
        // makes that call on every refresh while authorized. Firing
        // onArrival for a duplicate delivery therefore loops:
        // refresh -> register -> delivery -> refresh -> ..., each
        // iteration POSTing /device-tokens, until D1 throttles
        // (Nov 4, 2026: ~36 POSTs/sec, D1 "overloaded" 10s-window
        // errors on the session lookup of every authed request).
        // Only a changed token re-triggers a refresh; sign-out
        // resets lastDeliveredTokenHex so re-sign-in re-arms.
        guard tokenHex != lastDeliveredTokenHex else {
            pendingTokenHex = tokenHex
            return
        }
        lastDeliveredTokenHex = tokenHex
        pendingTokenHex = tokenHex
        onArrival?()
    }

    @MainActor
    static func receive(route: String?) {
        pendingRoute = route ?? "home"
        onArrival?()
    }
}

/// Captures the APNs device token and notification taps. Registering
/// for remote notifications happens only after the user says yes
/// (PermissionService.requestNotifications) — this delegate never
/// asks for permission itself.
final class HyggeAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = DeviceTokenEncoding.hexString(from: deviceToken)
        Task { @MainActor in PushInbox.receive(tokenHex: hex) }
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // No token means no registration and no sends. There is
        // nothing to retry here; the next granted foreground
        // registration (if any) delivers a token on its own.
    }

    /// A tap: hand the store the route and let it pull, then land on
    /// the task or feed item. The route is a reference only — it is
    /// never trusted as identity.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let userInfo = response.notification.request.content.userInfo
        let route = userInfo["hyggeRoute"] as? String
        Task { @MainActor in
            PushInbox.receive(route: route)
            completionHandler()
        }
    }

    /// Hygge open when a push lands: show nothing. A push only ever
    /// comes from a chat message, and the user is already looking at
    /// the app — the conversation itself is the notice. (iOS
    /// suppresses foreground pushes by default; presenting a banner
    /// here would override that.)
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([])
    }
}
