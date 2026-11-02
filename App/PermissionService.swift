import CoreLocation
import EventKit
import Foundation
import Observation
import UIKit
import UserNotifications

/// The three permissions onboarding asks for, each with a concrete reason the
/// chat explains before the system prompt appears. All are optional; the app
/// degrades clearly when declined (no booking / no nearby ranking / no pings).
enum PermissionService {
    static func requestCalendar() async -> Bool {
        (try? await EKEventStore().requestFullAccessToEvents()) ?? false
    }

    static func requestNotifications() async -> Bool {
        let center = UNUserNotificationCenter.current()
        let granted = (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) ?? false
        if granted {
            await MainActor.run { UIApplication.shared.registerForRemoteNotifications() }
        }
        return granted
    }

    /// The current notification answer, in the primer policy's
    /// terms. Provisional/ephemeral grants count as allowed; the
    /// primer itself is only ever for the undecided state.
    static func notificationAuthorization() async -> NotificationAuthorizationKind {
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        switch status {
        case .authorized, .provisional, .ephemeral: return .authorized
        case .denied: return .denied
        default: return .notDetermined
        }
    }
}

@Observable
final class LocationService: NSObject, CLLocationManagerDelegate {
    var localityLabel: String?
    var denied = false

    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<String?, Never>?

    override init() {
        super.init()
        manager.delegate = self
    }

    /// Asks for when-in-use permission and resolves the town/city name, which
    /// is all the profile needs. Returns nil when denied or unavailable.
    /// Never hangs: gives up after 12 seconds so the UI can say so.
    func requestLocality() async -> String? {
        if let localityLabel { return localityLabel }
        let timeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(12))
            await MainActor.run { self?.finish(nil) }
        }
        defer { timeout.cancel() }
        return await withCheckedContinuation { continuation in
            self.continuation = continuation
            manager.requestWhenInUseAuthorization()
            manager.requestLocation()
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.first else { return finish(nil) }
        CLGeocoder().reverseGeocodeLocation(location) { [weak self] placemarks, _ in
            let label = placemarks?.first.map { [$0.locality, $0.administrativeArea].compactMap { $0 }.joined(separator: ", ") }
            self?.localityLabel = label
            self?.finish(label)
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        denied = true
        finish(nil)
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if manager.authorizationStatus == .denied || manager.authorizationStatus == .restricted {
            denied = true
            finish(nil)
        }
    }

    private func finish(_ label: String?) {
        continuation?.resume(returning: label)
        continuation = nil
    }
}
