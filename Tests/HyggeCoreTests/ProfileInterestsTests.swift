import XCTest
@testable import HyggeCore

final class ProfileInterestsTests: XCTestCase {
    func testExistingProfileWithoutCustomInterestsStillDecodes() throws {
        let original = EarningsProfile(displayName: "Sam", interests: [.creative], locationLabel: "Austin, TX")
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(original)) as? [String: Any])
        json.removeValue(forKey: "customInterests")
        let restored = try JSONDecoder().decode(EarningsProfile.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertEqual(restored, original)
    }

    func testCustomInterestsSurviveProfileStateRoundTrip() throws {
        var profile = EarningsProfile(locationLabel: "Austin, TX")
        XCTAssertTrue(profile.addCustomInterest("  Pottery workshops \n"))
        XCTAssertFalse(profile.addCustomInterest("pottery WORKSHOPS"))
        XCTAssertFalse(profile.addCustomInterest(" \n "))
        XCTAssertEqual(profile.customInterests, ["Pottery workshops"])
        XCTAssertTrue(profile.skills.isEmpty)
        XCTAssertTrue(profile.isComplete)
        let state = ProfileState(profile: profile, hasOnboarded: true, isPaused: false, lastVisitAt: nil)
        let restored = try JSONDecoder().decode(ProfileState.self, from: JSONEncoder().encode(state))
        XCTAssertEqual(restored.profile, profile)
    }

    func testTypingAnExistingOptionSelectsItWithoutCreatingADuplicate() {
        var profile = EarningsProfile()
        XCTAssertTrue(profile.addCustomInterest(" pet CARE "))
        XCTAssertFalse(profile.addCustomInterest("Pet care"))
        XCTAssertEqual(profile.interests, [.petCare])
        XCTAssertTrue(profile.customInterests.isEmpty)
    }

    func testCustomInterestsReachDiscoveryWithoutBecomingSkills() {
        let profile = EarningsProfile(customInterests: ["Pottery workshops"])
        let site = TargetSite(id: "example", name: "Example", startURLString: "https://example.com", category: .creative, goalTemplate: "Find work")
        let task = AgentTaskFactory.discoverTask(profile: profile, site: site)
        XCTAssertEqual(task.draftedPayload["searchTerms"], "Pottery workshops")
        XCTAssertTrue(profile.skills.isEmpty)
    }
}
