import Foundation

/// Something Hygge believes about the user. Distinct from website-navigation
/// memory (how a site works) — beliefs are about the person, always visible,
/// editable, and deletable. The model may only PROPOSE beliefs; a proposal
/// becomes a belief solely when the user confirms the exact sentence.
public struct Belief: Codable, Identifiable, Equatable, Sendable {
    public enum Source: String, Codable, Sendable {
        case youSaidIt, learnedFromWork, guessedFromChat
        public var label: String {
            switch self {
            case .youSaidIt: return "You told me"
            case .learnedFromWork: return "Learned from your work"
            case .guessedFromChat: return "My guess — check me"
            }
        }
    }
    public var id: UUID
    public var sentence: String
    public var source: Source
    public var learnedAt: Date
    /// 0...1 — how sure Hygge is. Guesses stay visibly tentative.
    public var confidence: Double
    public init(id: UUID = UUID(), sentence: String, source: Source,
                learnedAt: Date = Date(), confidence: Double) {
        self.id = id
        self.sentence = sentence
        self.source = source
        self.learnedAt = learnedAt
        self.confidence = min(max(confidence, 0), 1)
    }
}

public struct BeliefBook: Codable, Equatable, Sendable {
    public var beliefs: [Belief] = []
    /// Quoted, waiting for the user's yes/no. Never applied silently.
    public var pending: [Belief] = []
    public init() {}

    public mutating func propose(sentence: String, source: Belief.Source, confidence: Double) {
        let clean = sentence.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty,
              !beliefs.contains(where: { $0.sentence == clean }),
              !pending.contains(where: { $0.sentence == clean }) else { return }
        pending.append(Belief(sentence: clean, source: source, confidence: confidence))
    }

    public mutating func confirm(proposalID: UUID) {
        guard let index = pending.firstIndex(where: { $0.id == proposalID }) else { return }
        var belief = pending.remove(at: index)
        belief.learnedAt = Date()
        beliefs.append(belief)
    }

    public mutating func reject(proposalID: UUID) {
        pending.removeAll { $0.id == proposalID }
    }

    public mutating func edit(beliefID: UUID, sentence: String) {
        guard let index = beliefs.firstIndex(where: { $0.id == beliefID }) else { return }
        beliefs[index].sentence = sentence
        beliefs[index].source = .youSaidIt
        beliefs[index].confidence = 1
    }

    public mutating func delete(beliefID: UUID) {
        beliefs.removeAll { $0.id == beliefID }
    }
}
