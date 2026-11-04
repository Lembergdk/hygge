import XCTest
@testable import HyggeCore

/// Brief 06 feed ordering: the one server ranker's score is the only
/// ordering truth in the feed. These tests pin the consumer-side
/// contract the Home feed relies on (docs/profile-learning.md).
final class FeedRankOrderingTests: XCTestCase {
    private func opp(_ title: String, rank: Double?) -> Opportunity {
        Opportunity(siteID: "rover", title: title, summary: "", category: .petCare,
                    payLabel: "", estimatedHourly: 60, locationLabel: "Leeds",
                    isRemote: true, requiredSkills: [], urlString: "", rankScore: rank)
    }

    func testScoredFirstDescendingUnscoredLast() {
        let items = [opp("unscored", rank: nil), opp("mid", rank: 0.6),
                     opp("top", rank: 0.9), opp("zero-scored", rank: 0.0)]
        let ordered = FeedRankOrdering.sorted(items, rankScore: \.rankScore)
        // A real score of 0.0 still outranks "no score": unscored
        // items (live-discovered, blocked looks) go last, never
        // mingled by a `?? 0` default.
        XCTAssertEqual(ordered.map(\.title), ["top", "mid", "zero-scored", "unscored"])
    }

    func testTiesAndUnscoredKeepOriginalOrder() {
        let items = [opp("a", rank: 0.7), opp("b", rank: nil),
                     opp("c", rank: 0.7), opp("d", rank: nil)]
        let ordered = FeedRankOrdering.sorted(items, rankScore: \.rankScore)
        XCTAssertEqual(ordered.map(\.title), ["a", "c", "b", "d"])
    }

    func testHighlightedItemLeadsEvenWhenUnscored() {
        let target = opp("from-push", rank: nil)
        let items = [opp("top", rank: 0.95), target, opp("mid", rank: 0.6)]
        let ordered = FeedRankOrdering.sorted(items, rankScore: \.rankScore) { $0.id == target.id }
        XCTAssertEqual(ordered.map(\.title), ["from-push", "top", "mid"])
    }

    func testProposalsOrderByServerScore() {
        let low = ProposedSite(siteID: "low", rationale: "", rankScore: 0.5)
        let high = ProposedSite(siteID: "high", rationale: "", rankScore: 0.9)
        let local = ProposedSite(siteID: "local", rationale: "")
        let ordered = FeedRankOrdering.sorted([low, local, high], rankScore: \.rankScore)
        XCTAssertEqual(ordered.map(\.siteID), ["high", "low", "local"])
    }

    func testProposalRankScoreSurvivesExportRoundTrip() throws {
        let proposal = ProposedSite(siteID: "rover", rationale: "pets", rankScore: 0.82)
        let export = ServerExport(
            proposals: [StateRow(id: proposal.id.uuidString,
                                 updatedAt: "2026-11-04T00:00:00Z", data: proposal)])
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        let rebuilt = try decoder.decode(ServerExport.self, from: encoder.encode(export))
        XCTAssertEqual(rebuilt.proposals.first?.data.rankScore, 0.82)
    }

    func testOlderProposalPayloadWithoutRankScoreDecodes() throws {
        // Payloads stored before proposals carried a score must keep
        // decoding (score simply absent → sorts as unscored).
        let json = """
        {"id":"00000000-0000-0000-0000-000000000001","siteID":"rover",
         "rationale":"pets","payPattern":"p","dataShared":"d",
         "verification":"v","status":"proposed"}
        """
        let decoded = try JSONDecoder().decode(ProposedSite.self, from: Data(json.utf8))
        XCTAssertNil(decoded.rankScore)
    }
}
