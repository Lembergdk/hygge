import SwiftUI
import EventKit
import CoreLocation

struct SettingsPermissionsView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @State private var location = SettingsLocationAuthorization()
    @State private var notifications: NotificationAuthorizationKind = .notDetermined
    @State private var calendar = EKEventStore.authorizationStatus(for: .event)
    @State private var busy: String?
    var body: some View {
        SettingsPage(title: "Permissions") {
            SettingsIntro(title: "A little help, only if you say yes.", artwork: "SettingsPermissions")
            Text("Choose what Hygge can use.").foregroundStyle(HyggeTheme.secondary)
            permission("Notifications", icon: "bell", color: HyggeTheme.sageDeep,
                       explanation: "Know when something needs your OK, or new work turns up.",
                       label: notifications == .authorized ? "Manage notifications" : notifications == .denied ? "Open Settings" : "Allow notifications") {
                if notifications != .notDetermined { settings(); return }
                busy = "Notifications"
                Task { await store.allowNotifications(); await refresh(); busy = nil }
            }
            permission("Calendar", icon: "calendar", color: HyggeTheme.butterText,
                       explanation: "Check availability and add confirmed work to your calendar.",
                       label: calendar == .fullAccess ? "Manage calendar access" : calendar == .denied || calendar == .restricted ? "Open Settings" : "Allow calendar access") {
                if calendar == .fullAccess || calendar == .denied || calendar == .restricted { settings(); return }
                busy = "Calendar"
                Task { _ = await PermissionService.requestCalendar(); await refresh(); busy = nil }
            }
            permission("Location", icon: "mappin.circle", color: HyggeTheme.ember,
                       explanation: "Use your location to find work nearby.",
                       label: location.authorized ? "Manage location access" : location.status == .notDetermined ? "Allow location access" : "Open Settings") {
                if location.status == .notDetermined { location.request() } else { settings() }
            }
            Text("You can change access in Settings.").font(.caption).foregroundStyle(HyggeTheme.secondary)
        }
        .task { await refresh() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await refresh() } } }
    }
    private func permission(_ title: String, icon: String, color: Color, explanation: String, label: String, action: @escaping () -> Void) -> some View {
        VStack(spacing: 20) {
            Divider()
            HStack(alignment: .top, spacing: 18) {
                Image(systemName: icon).font(.system(size: 30)).foregroundStyle(color).frame(width: 36)
                VStack(alignment: .leading, spacing: 12) {
                    Text(title).font(.title3.weight(.bold)).foregroundStyle(HyggeTheme.ink)
                    Text(explanation).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                    Button(action: action) {
                        if busy == title { ProgressView() } else { Text(label) }
                    }.buttonStyle(SettingsActionStyle(filled: false)).disabled(busy != nil)
                }
            }
        }
    }
    private func refresh() async {
        notifications = await PermissionService.notificationAuthorization()
        calendar = EKEventStore.authorizationStatus(for: .event)
        location.refresh()
    }
    private func settings() {
        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
    }
}

/// Permission-only request: granting location never silently rewrites the
/// user's chosen town. The existing onboarding location lookup stays separate.
@Observable final class SettingsLocationAuthorization: NSObject, CLLocationManagerDelegate {
    var status: CLAuthorizationStatus = .notDetermined
    private let manager = CLLocationManager()
    var authorized: Bool { status == .authorizedAlways || status == .authorizedWhenInUse }
    override init() { super.init(); manager.delegate = self; refresh() }
    func refresh() { status = manager.authorizationStatus }
    func request() { manager.requestWhenInUseAuthorization() }
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) { refresh() }
}
