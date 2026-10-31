import XCTest
@testable import HyggeCore

final class HyggeCoreTests: XCTestCase {
    func testBackendAddressDropsStaleLocalURLs() {
        let fallback = "https://api-staging.usehygge.app"
        // Leftovers from the retired LAN dev backend are ignored.
        XCTAssertEqual(BackendAddress.effective(stored: "http://127.0.0.1:8787", fallback: fallback), fallback)
        XCTAssertEqual(BackendAddress.effective(stored: "http://192.168.1.20:8787", fallback: fallback), fallback)
        XCTAssertEqual(BackendAddress.effective(stored: "http://localhost:8787", fallback: fallback), fallback)
        XCTAssertEqual(BackendAddress.effective(stored: nil, fallback: fallback), fallback)
        XCTAssertEqual(BackendAddress.effective(stored: "", fallback: fallback), fallback)
        // A real https override is respected.
        XCTAssertEqual(BackendAddress.effective(stored: "https://api.usehygge.app", fallback: fallback),
                       "https://api.usehygge.app")
    }

    func testBackendAddressDetectsStaleLocalPair() {
        XCTAssertTrue(BackendAddress.isStaleLocal(stored: "http://192.168.1.20:8787"))
        XCTAssertTrue(BackendAddress.isStaleLocal(stored: "http://127.0.0.1:8787"))
        XCTAssertFalse(BackendAddress.isStaleLocal(stored: "https://api-staging.usehygge.app"))
        XCTAssertFalse(BackendAddress.isStaleLocal(stored: nil))
    }

    func testCloudRequirementResolution() {
        // Explicit Info.plist value wins, whatever the build.
        XCTAssertTrue(CloudRequirement.resolve(infoPlistValue: "YES", isDebugBuild: true))
        XCTAssertFalse(CloudRequirement.resolve(infoPlistValue: "NO", isDebugBuild: false))
        // Absent value: Debug may work locally, Release must require cloud.
        XCTAssertFalse(CloudRequirement.resolve(infoPlistValue: nil, isDebugBuild: true))
        XCTAssertTrue(CloudRequirement.resolve(infoPlistValue: nil, isDebugBuild: false))
        // Garbage is treated as absent, never as a silent yes in Debug.
        XCTAssertFalse(CloudRequirement.resolve(infoPlistValue: "banana", isDebugBuild: true))
    }

    func testLocalFallbackRequiresPermission() {
        XCTAssertTrue(CloudRequirement.mayRunLocally(requireCloud: false))
        XCTAssertFalse(CloudRequirement.mayRunLocally(requireCloud: true))
    }

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

    func testThreeQuestionOnboarding() {
        var chat = OnboardingConversation()
        XCTAssertTrue(chat.submitText(""))                 // welcome -> Q1
        XCTAssertEqual(chat.step, .enjoyWork)
        XCTAssertFalse(chat.confirmEnjoyWork())            // nothing chosen yet
        chat.toggleCategory(.petCare)
        XCTAssertTrue(chat.confirmEnjoyWork())             // -> Q2
        XCTAssertEqual(chat.step, .lowestRate)
        XCTAssertTrue(chat.submitText("30"))               // -> Q3
        XCTAssertEqual(chat.step, .whereWhen)
        chat.profile.availabilityNotes = "Weekends"
        XCTAssertTrue(chat.submitText("Leeds"))            // -> summary
        XCTAssertEqual(chat.step, .summary)
        XCTAssertTrue(chat.profile.isComplete)
        XCTAssertEqual(chat.profile.hourlyRateFloor, 30)
    }

    /// LLM turns personalize the script: facts volunteered early are extracted
    /// and chips become tailored — not presets.
    func testLLMTurnExtractsAndTailors() {
        var chat = OnboardingConversation()
        _ = chat.submitText("") // welcome -> enjoyWork
        chat.applyAssistant(OnboardingAssistantReply(
            reply: "Dog walking in Leeds plus TikTok editing — lovely mix. What kinds of work should I hunt for?",
            extracted: EarningsProfilePatch(displayName: "Sam", interests: [.petCare, .creative],
                                            skills: ["Dog walking", "Video editing"], locationLabel: "Leeds"),
            suggestedCategories: [.petCare, .creative, .freelance],
            suggestedSkills: ["Dog walking", "Pet sitting", "Video editing", "Pet photography"]))
        XCTAssertEqual(chat.profile.locationLabel, "Leeds")
        XCTAssertEqual(chat.suggestedCategories.first, .petCare)
        XCTAssertTrue(chat.suggestedSkills.contains("Pet photography"))
        XCTAssertTrue(chat.confirmEnjoyWork())
        _ = chat.submitText("25") // rate -> whereWhen, location already known only if availability also known
        XCTAssertEqual(chat.step, .whereWhen)
        chat.profile.availabilityNotes = "Mornings"
        XCTAssertTrue(chat.submitText("")) // location already satisfied
        XCTAssertEqual(chat.step, .summary)
    }

    func testFeeAndTimeSavedLanguage() {
        let parts = HyggeFee.breakdown(gross: 28)
        XCTAssertEqual(parts.fee, 4.20, accuracy: 0.001)
        XCTAssertEqual(parts.net, 23.80, accuracy: 0.001)
        XCTAssertEqual(TimeSaved.aboutLabel(minutes: 5), "a few minutes")
        XCTAssertEqual(TimeSaved.aboutLabel(minutes: 47), "about 40 minutes")
        XCTAssertEqual(TimeSaved.aboutLabel(minutes: 130), "about 2 hours")
        XCTAssertEqual(TimeSaved.aboutLabel(minutes: 170), "about 2.5 hours")
    }

    /// Journal renders ONLY witnessed events — no inferred activity, and no
    /// money parsed out of display labels like "$25/hr" (P0 honesty rules).
    func testJournalRendersWitnessedEventsOnly() {
        XCTAssertTrue(JournalBuilder.entries(from: []).isEmpty,
                      "no witnessed events means an empty journal, never invented activity")
        let event = ActivityEvent(kind: .searchedSite, sentence: "Checked Rover for new work.",
                                  detail: "Visited Rover and looked for matching work.")
        let entries = JournalBuilder.entries(from: [event])
        XCTAssertEqual(entries.first?.sentence, "Checked Rover for new work.")
        XCTAssertEqual(JournalBuilder.money(24), "$24.00")
    }

    /// Zero witnessed work must claim zero time saved — never "a few minutes".
    func testTimeSavedZeroClaimsNothing() {
        XCTAssertEqual(TimeSaved.aboutLabel(minutes: 0), "none yet")
        XCTAssertEqual(TimeSaved.estimatedMinutes(listingsRead: 0, draftsWritten: 0, searchRuns: 0), 0)
    }

    /// Every site the app can suggest must carry specific consent facts —
    /// a generic rationale card must never reach the user.
    func testEverySeedSiteHasSpecificConsentFacts() {
        for site in SeedSites.all {
            let d = ConsentCatalog.details(for: site)
            XCTAssertFalse(d.pay.isEmpty, "\(site.id) missing pay pattern")
            XCTAssertFalse(d.data.isEmpty, "\(site.id) missing shared-data summary")
            XCTAssertFalse(d.verification.isEmpty, "\(site.id) missing verification summary")
        }
    }

    func testHonestTimeSavedAndFeePreview() {
        XCTAssertEqual(TimeSaved.cozyAfternoons(minutes: 119), 0)
        XCTAssertEqual(TimeSaved.cozyAfternoons(minutes: 240), 2)
        XCTAssertFalse(HyggeFee.isFinalized,
                       "fee must stay a labelled preview until the business model is settled")
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

    // MARK: - P1

    /// No recommendation sentence below the confidence threshold; evidence
    /// is concrete (rate vs floor) either way.
    func testRecommendationNeedsConfidence() {
        let strong = SampleData.opportunities.first { $0.siteID == "rover" }!
        let strongMatch = MatchEngine.evaluate(profile: petProfile(), opportunity: strong)
        XCTAssertNotNil(MatchEngine.recommendation(for: strongMatch))
        XCTAssertTrue(strongMatch.evidence.contains { $0.contains("floor") })

        let weak = SampleData.opportunities.first { $0.siteID == "indeed" }!
        let weakMatch = MatchEngine.evaluate(profile: petProfile(), opportunity: weak)
        XCTAssertNil(MatchEngine.recommendation(for: weakMatch),
                     "below-threshold matches must get no recommendation sentence")
    }

    /// Negative-space evidence: survey counts every listing it read, why the
    /// dropped ones were dropped, and phrases a truthful journal line.
    func testSurveyKeepsNegativeSpaceEvidence() {
        let cheap = Opportunity(siteID: "rover", title: "Dog walk for peanuts", summary: "",
                                category: .petCare, payLabel: "$8/hr", estimatedHourly: 8,
                                locationLabel: "Leeds", isRemote: false, requiredSkills: ["Dog walking"],
                                urlString: "https://rover.com/x")
        let good = Opportunity(siteID: "rover", title: "Weekend dog sitting", summary: "",
                               category: .petCare, payLabel: "$30/hr", estimatedHourly: 30,
                               locationLabel: "Leeds", isRemote: false, requiredSkills: ["Pet sitting"],
                               urlString: "https://rover.com/y")
        let survey = MatchEngine.survey(profile: petProfile(), opportunities: [cheap, good], siteID: "rover")
        XCTAssertEqual(survey.listingsRead, 2)
        XCTAssertEqual(survey.dropped.count, 1)
        XCTAssertEqual(survey.dropped.first?.title, "Dog walk for peanuts")
        XCTAssertTrue(survey.dropped.first?.reason.contains("floor") ?? false)
        XCTAssertTrue(survey.journalSentence.contains("Read two"))
        XCTAssertTrue(survey.journalSentence.contains("dropped"))
    }

    /// Batching compares every material field in full — identical first 120
    /// characters is NOT enough — and money/time actions never batch.
    func testBatchingComparesMaterialFields() {
        let opp = SampleData.opportunities[0]
        var a = AgentTaskFactory.applyTask(profile: petProfile(), opportunity: opp)
        var b = AgentTaskFactory.applyTask(profile: petProfile(), opportunity: opp)
        let groups = TaskBatching.groups([a, b])
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups.first?.count, 2)

        b.draftedPayload["coverLetter"]! += " One extra sentence that changes everything."
        XCTAssertEqual(TaskBatching.groups([a, b]).count, 2, "different letter bodies must not batch")

        let book1 = AgentTaskFactory.bookCalendarTask(opportunity: opp, when: Date())
        let book2 = AgentTaskFactory.bookCalendarTask(opportunity: opp, when: Date())
        XCTAssertTrue(TaskBatching.groups([book1, book2]).allSatisfy { $0.count == 1 },
                      "calendar bookings are never batched")
    }

    /// Beliefs are never silently mutated: a proposal is invisible until the
    /// user confirms the exact quoted sentence.
    func testBeliefsNeverMutateSilently() {
        var book = BeliefBook()
        book.propose(sentence: "Prefers morning dog walks", source: .guessedFromChat, confidence: 0.6)
        XCTAssertTrue(book.beliefs.isEmpty, "unconfirmed proposal must not become a belief")
        XCTAssertEqual(book.pending.count, 1)

        let proposal = book.pending[0]
        book.confirm(proposalID: proposal.id)
        XCTAssertEqual(book.beliefs.first?.sentence, "Prefers morning dog walks")
        XCTAssertTrue(book.pending.isEmpty)

        book.propose(sentence: "Has a car", source: .youSaidIt, confidence: 0.95)
        book.reject(proposalID: book.pending[0].id)
        XCTAssertEqual(book.beliefs.count, 1)

        let id = book.beliefs[0].id
        book.edit(beliefID: id, sentence: "Prefers early morning walks")
        XCTAssertEqual(book.beliefs[0].sentence, "Prefers early morning walks")
        book.delete(beliefID: id)
        XCTAssertTrue(book.beliefs.isEmpty)
    }

    /// Chat commands are structured and strict: a sentence merely mentioning
    /// the word "pause" must not pause anything.
    func testChatActionParserIsStrict() {
        XCTAssertEqual(ChatActionParser.parse("Please don't pause Rover, I love it"), nil)
        XCTAssertEqual(ChatActionParser.parse("pause"), .pause)
        XCTAssertEqual(ChatActionParser.parse("Pause everything for now"), .pause)
        XCTAssertEqual(ChatActionParser.parse("resume"), .resume)
        XCTAssertEqual(ChatActionParser.parse("set my floor to $30"), .changeFloor(30))
        XCTAssertEqual(ChatActionParser.parse("what did you skip?"), .explainDropped)
        XCTAssertEqual(ChatActionParser.parse("hello there"), nil)
    }

    /// Every site state the reconciliation model needs exists with a human label.
    func testSiteStatesAreComplete() {
        for state: SiteAccountState in [.proposed, .joining, .needsVerification, .watching, .paused, .stopped, .disconnected] {
            XCTAssertFalse(state.label.isEmpty, "\(state) needs a label")
        }
    }

    /// Tile labels must fit a two-column tile whole — no hyphenated truncation.
    func testTileLabelsFit() {
        for category in OpportunityCategory.allCases {
            XCTAssertFalse(category.tileLabel.isEmpty)
            XCTAssertLessThanOrEqual(category.tileLabel.count, 12, "\(category) tile label too long")
            XCTAssertFalse(category.activityLabel.isEmpty)
        }
    }

    /// Onboarding can go back a question, and progress counts only real questions.
    func testOnboardingBackNavigationAndProgress() {
        var chat = OnboardingConversation()
        XCTAssertEqual(chat.questionNumber, nil)
        _ = chat.submitText("") // welcome -> enjoyWork
        XCTAssertEqual(chat.questionNumber, 1)
        chat.profile.interests = [.petCare]
        XCTAssertTrue(chat.confirmEnjoyWork())
        XCTAssertEqual(chat.questionNumber, 2)
        chat.goBack()
        XCTAssertEqual(chat.step, .enjoyWork)
        XCTAssertEqual(chat.questionNumber, 1)
    }
}
