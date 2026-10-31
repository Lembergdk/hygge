import Foundation

/// One plain-sentence journal entry: what Hygge did, written for a human.
/// Derived from real artifacts (tasks, applications, memories) — never
/// invented activity. Expandable detail is the audit view.
public struct JournalEntry: Identifiable, Equatable, Sendable {
    public var id: String
    public var date: Date
    public var sentence: String
    public var why: String
    public var applicationID: UUID?
    public init(id: String, date: Date, sentence: String, why: String, applicationID: UUID? = nil) {
        self.id = id
        self.date = date
        self.sentence = sentence
        self.why = why
        self.applicationID = applicationID
    }
}

public enum JournalBuilder {
    /// Journal entries are a direct rendering of witnessed ActivityEvents.
    public static func entries(from events: [ActivityEvent]) -> [JournalEntry] {
        events.sorted { $0.occurredAt > $1.occurredAt }.map {
            JournalEntry(id: "event-\($0.id)", date: $0.occurredAt, sentence: $0.sentence,
                         why: $0.detail, applicationID: $0.applicationID)
        }
    }

    public static func money(_ value: Double, currencyCode: String = "USD") -> String {
        value.formatted(.currency(code: currencyCode))
    }

    public static func dayLabel(for date: Date, now: Date = Date()) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}
