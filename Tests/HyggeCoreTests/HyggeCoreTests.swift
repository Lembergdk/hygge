import XCTest
@testable import HyggeCore

final class HyggeCoreTests: XCTestCase {
    private func petProfile() -> EarningsProfile {
        EarningsProfile(displayName: "Sam", headline: "Dog sitter",
                        skills: ["Pet sitting", "Dog walking"], interests: [.petCare],
                        hourlyRateFloor: 25, locationLabel: "Leeds")
    }

    func testMatchingRewardsInterestSkillsAndPay() {
        let rover = SampleData.opportunities.first { $0.siteID == "rover" }!
        let bookkeeping = SampleData.opportunities.first { $0.siteID == "indeed" }!
        XCTAssertGreaterThan(MatchEngine.evaluate(profile: petProfile(), opportunity: rover).score, 0.8)
        XCTAssertLessThan(MatchEngine.evaluate(profile: petProfile(), opportunity: bookkeeping).score, 0.8)
    }

    func testRunnerRefusesUnapprovedWriteTask() {
        let task = AgentTaskFactory.applyTask(profile: petProfile(), opportunity: SampleData.opportunities[0])
        var repository = SiteMemoryRepository()
        XCTAssertThrowsError(try SimulatedMissionRunner().run(task, repository: &repository)) { error in
            XCTAssertEqual(error as? AgentError, .notApproved)
        }
    }

    func testAnySiteCanBeAddedAndDomainParsed() {
        let site = TargetSite.userAdded(name: "", urlOrDomain: "www.mycity-petsitters.com/jobs", category: .petCare)
        XCTAssertEqual(site?.domain, "mycity-petsitters.com")
        XCTAssertNil(TargetSite.userAdded(name: "", urlOrDomain: "not a domain", category: .petCare))
        XCTAssertGreaterThanOrEqual(SeedSites.all.count, 15)
    }

    /// The mission-first contract: a run on a brand-new domain succeeds with
    /// NO pre-existing skill/script — memory (hints) is created BY the run,
    /// and the second run merely consults it.
    func testMissionFirstThenMemory() throws {
        var repository = SiteMemoryRepository()
        XCTAssertTrue(repository.memories.isEmpty, "must start with no scripts or memory")

        var first = AgentTaskFactory.applyTask(profile: petProfile(), opportunity: SampleData.opportunities[0])
        try first.approve()
        let firstResult = try SimulatedMissionRunner().run(first, repository: &repository)
        XCTAssertEqual(firstResult.status, .succeeded)
        XCTAssertEqual(firstResult.browserTrace.last?.action, .done, "agent decides when it is done")
        XCTAssertTrue(firstResult.log.contains { $0.contains("no memory yet") })

        let learned = repository.memory(domain: "rover.com", kind: .apply)
        XCTAssertNotNil(learned)
        XCTAssertFalse(learned!.hints.isEmpty, "trajectory should distil into advisory hints")
        XCTAssertEqual(learned?.successCount, 1)
        XCTAssertEqual(firstResult.memoryID, learned?.id)
        let confidenceAfterOne = learned?.confidence ?? 0

        var second = AgentTaskFactory.applyTask(profile: petProfile(), opportunity: SampleData.opportunities[0])
        try second.approve()
        let secondResult = try SimulatedMissionRunner().run(second, repository: &repository)
        XCTAssertEqual(secondResult.status, .succeeded)
        XCTAssertTrue(secondResult.log.contains { $0.contains("advisory memory hint") })
        let reused = repository.memory(domain: "rover.com", kind: .apply)
        XCTAssertEqual(reused?.successCount, 2)
        XCTAssertGreaterThan(reused?.confidence ?? 0, confidenceAfterOne)

        repository.recordOutcome(memoryID: learned!.id, success: false)
        XCTAssertLessThan(repository.memory(domain: "rover.com", kind: .apply)?.confidence ?? 1,
                          reused?.confidence ?? 0)
    }

    func testCredentialRefCannotCarrySecret() throws {
        let ref = CredentialRef(domain: "upwork.com", username: "sam@example.com")
        let json = String(data: try JSONEncoder().encode(ref), encoding: .utf8)!
        XCTAssertTrue(json.contains("upwork.com"))
        XCTAssertFalse(json.lowercased().contains("secret"))
        XCTAssertFalse(json.lowercased().contains("password"))
    }

    func testVaultCredentialInjectionIsTracedButRedacted() throws {
        var repository = SiteMemoryRepository()
        var task = AgentTaskFactory.applyTask(profile: petProfile(), opportunity: SampleData.opportunities[0])
        task.credentialRefID = UUID()
        try task.approve()
        let result = try SimulatedMissionRunner().run(task, repository: &repository)
        XCTAssertTrue(result.browserTrace.contains { $0.summary.contains("vault") })
        XCTAssertTrue(result.goal.contains("CAPTCHA"))
    }

    func testDiscoverMissionExtractsAndFinishes() throws {
        var repository = SiteMemoryRepository()
        let rover = SeedSites.site(id: "rover")!
        var task = AgentTaskFactory.discoverTask(profile: petProfile(), site: rover)
        try task.approve()
        let result = try SimulatedMissionRunner().run(task, repository: &repository)
        XCTAssertEqual(result.status, .succeeded)
        XCTAssertTrue(result.browserTrace.contains { $0.action == .extract && $0.succeeded })
    }

    func testChatOnboardingBuildsProfile() {
        var chat = OnboardingConversation()
        XCTAssertTrue(chat.submitText(""))            // welcome -> name
        XCTAssertFalse(chat.submitText("  "))         // name required
        XCTAssertTrue(chat.submitText("Sam"))
        XCTAssertFalse(chat.confirmCategories())      // none picked yet
        chat.toggleCategory(.petCare)
        XCTAssertTrue(chat.confirmCategories())
        chat.toggleSkill("Dog walking")
        XCTAssertTrue(chat.submitText("Pet sitting")) // chips + free text both land
        XCTAssertTrue(chat.submitText("Leeds"))
        XCTAssertTrue(chat.submitText("30"))          // pay floor
        XCTAssertTrue(chat.submitText("Weekends"))
        XCTAssertFalse(chat.submitText("not-an-email"))
        XCTAssertTrue(chat.submitText("sam@example.com"))
        XCTAssertTrue(chat.submitText(""))            // permissions -> summary
        XCTAssertEqual(chat.step, .summary)
        XCTAssertTrue(chat.profile.isComplete)
        XCTAssertEqual(chat.profile.email, "sam@example.com")
        XCTAssertEqual(chat.profile.hourlyRateFloor, 30)
        XCTAssertEqual(Set(chat.profile.skills), ["Dog walking", "Pet sitting"])
    }

    /// LLM turns personalize the script: facts volunteered early are extracted,
    /// satisfied steps are skipped, and chips become tailored — not presets.
    func testLLMTurnExtractsAndTailors() {
        var chat = OnboardingConversation()
        _ = chat.submitText("") // welcome -> name
        _ = chat.submitText("I'm Sam from Leeds, I walk dogs and edit TikToks")
        XCTAssertEqual(chat.step, .categories)
        chat.applyAssistant(OnboardingAssistantReply(
            reply: "Lovely, Sam — dog walking in Leeds plus TikTok editing is a great combo. What kinds of work should I hunt for?",
            extracted: EarningsProfilePatch(displayName: "Sam", interests: [.petCare, .creative],
                                            skills: ["Dog walking", "Video editing"], locationLabel: "Leeds"),
            suggestedCategories: [.petCare, .creative, .freelance],
            suggestedSkills: ["Dog walking", "Pet sitting", "Video editing", "Pet photography"]))
        XCTAssertEqual(chat.profile.locationLabel, "Leeds", "early-volunteered location is kept")
        XCTAssertEqual(chat.suggestedCategories.first, .petCare)
        XCTAssertTrue(chat.suggestedSkills.contains("Pet photography"), "suggestions inferred, beyond literal words")
        XCTAssertTrue(chat.confirmCategories())
        _ = chat.submitText("") // skills already extracted -> advance past skills AND location
        XCTAssertEqual(chat.step, .payFloor, "location step skipped: already known from free text")
    }

    func testPetCareProposals() {
        let proposals = SiteProposals.generate(profile: petProfile(), sites: SeedSites.all)
        XCTAssertTrue(proposals.contains { $0.siteID == "rover" })
        XCTAssertFalse(proposals.contains { $0.siteID == "upwork" }, "only interest categories are proposed")
        XCTAssertTrue(proposals.allSatisfy { $0.status == .proposed && !$0.rationale.isEmpty })
    }

    /// Signup has unknowns: the agent must ask rather than invent, then
    /// complete once the user answers and re-approves.
    func testSignupAsksForMissingInformationThenResumes() throws {
        var repository = SiteMemoryRepository()
        let rover = SeedSites.site(id: "rover")!
        var task = AgentTaskFactory.signupTask(profile: petProfile(), site: rover)
        try task.approve()
        let paused = try SimulatedMissionRunner().run(task, repository: &repository)
        XCTAssertEqual(paused.status, .needsHuman)
        XCTAssertTrue(paused.informationRequests.contains { $0.lowercased().contains("phone") })

        var resumed = paused
        resumed.draftedPayload["phone"] = "+44 7000 000000"
        resumed.draftedPayload["dateOfBirth"] = "1990-01-01"
        resumed.informationRequests = []
        try resumed.requestReapproval()
        try resumed.approve()
        let done = try SimulatedMissionRunner().run(resumed, repository: &repository)
        XCTAssertEqual(done.status, .succeeded)
    }

    func testRejectIsTerminalForApproval() throws {
        var task = AgentTaskFactory.applyTask(profile: petProfile(), opportunity: SampleData.opportunities[0])
        try task.reject()
        XCTAssertThrowsError(try task.approve())
    }
}
