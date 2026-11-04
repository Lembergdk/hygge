import EventKit
import Foundation

enum CalendarService {
    /// Adds an event from an approved bookCalendar task payload.
    /// Returns false when permission is denied or the payload is incomplete.
    static func book(payload: [String: String], operationID: String? = nil) async -> Bool {
        guard let title = payload["eventTitle"],
              let iso = payload["eventStartISO8601"],
              let start = ISO8601DateFormatter().date(from: iso) else { return false }
        let store = EKEventStore()
        let granted = (try? await store.requestFullAccessToEvents()) ?? false
        guard granted, let calendar = store.defaultCalendarForNewEvents else { return false }
        let marker = operationID.flatMap { URL(string: "hygge://calendar/\($0)") }
        if let marker {
            let range = store.predicateForEvents(withStart: start.addingTimeInterval(-86400),
                end: start.addingTimeInterval(3 * 86400), calendars: nil)
            if store.events(matching: range).contains(where: { $0.url == marker }) { return true }
        }
        let event = EKEvent(eventStore: store)
        event.url = marker
        event.title = title
        event.startDate = start
        event.endDate = start.addingTimeInterval(2 * 3600)
        event.location = payload["location"]
        event.calendar = calendar
        event.notes = "Booked by Hygge after your approval."
        return (try? store.save(event, span: .thisEvent)) != nil
    }
}
