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

    /// One question per message: enjoy → rate → where → when → summary.
    func testOnboardingOneQuestionPerMessage() {
        var chat = OnboardingConversation()
        XCTAssertTrue(chat.submitText(""))                 // welcome -> Q1
        XCTAssertEqual(chat.step, .enjoyWork)
        XCTAssertFalse(chat.confirmEnjoyWork())            // nothing chosen yet
        chat.toggleCategory(.petCare)
        XCTAssertTrue(chat.confirmEnjoyWork())             // -> Q2
        XCTAssertEqual(chat.step, .lowestRate)
        XCTAssertTrue(chat.submitText("30"))               // -> where
        XCTAssertEqual(chat.step, .where)
        XCTAssertTrue(chat.submitText("Leeds"))            // -> when
        XCTAssertEqual(chat.step, .when)
        XCTAssertTrue(chat.submitText("Weekends"))         // -> summary
        XCTAssertEqual(chat.step, .summary)
        XCTAssertTrue(chat.profile.isComplete)
        XCTAssertEqual(chat.profile.hourlyRateFloor, 30)
        XCTAssertEqual(chat.profile.locationLabel, "Leeds")
        XCTAssertEqual(chat.profile.availabilityNotes, "Weekends")
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
        _ = chat.submitText("25") // rate -> where (already known, skipped) -> when
        XCTAssertEqual(chat.step, .when)
        chat.profile.availabilityNotes = "Mornings"
        XCTAssertTrue(chat.submitText("")) // availability already satisfied
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

    // MARK: - Brief 06: profile learning

    func testFeedbackReasonsMatchFeedStrings() {
        XCTAssertEqual(FeedbackReason.from(uiString: "too low"), .tooLow)
        XCTAssertEqual(FeedbackReason.from(uiString: "too far"), .tooFar)
        XCTAssertEqual(FeedbackReason.from(uiString: "not their thing"), .notMyThing)
        XCTAssertEqual(FeedbackReason.from(uiString: "just busy"), .justBusy)
        XCTAssertNil(FeedbackReason.from(uiString: nil))
    }

    func testLearningDeltasAndFloorPromptOnly() {
        var learning = LearningProfile()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        for i in 0..<5 {
            learning.apply(FeedbackEvent(subjectType: .opportunity, subjectId: "o\(i)",
                                         action: .declined, reason: .tooLow,
                                         category: .petCare, occurredAt: now))
        }
        XCTAssertEqual(learning.tooLowDeclines, 5)
        XCTAssertEqual(learning.rateSensitivity, 1, accuracy: 1e-9)
        XCTAssertEqual(learning.affinity(for: .petCare), -0.25, accuracy: 1e-9)
        XCTAssertTrue(learning.shouldPromptRateFloorReview, "prompt only — LearningProfile cannot move the floor")

        var mixed = LearningProfile()
        mixed.apply(FeedbackEvent(subjectType: .opportunity, subjectId: "a", action: .accepted,
                                  category: .petCare, requiredSkills: ["Dog walking"], occurredAt: now))
        mixed.apply(FeedbackEvent(subjectType: .opportunity, subjectId: "i", action: .ignored,
                                  category: .freelance, occurredAt: now))
        mixed.apply(FeedbackEvent(subjectType: .opportunity, subjectId: "d", action: .declined,
                                  reason: .other, category: .creative, occurredAt: now))
        XCTAssertEqual(mixed.affinity(for: .petCare), 0.20, accuracy: 1e-9)
        XCTAssertEqual(mixed.affinity(for: .freelance), -0.05, accuracy: 1e-9, "ignored is weaker than declined")
        XCTAssertEqual(mixed.affinity(for: .creative), -0.20, accuracy: 1e-9)
    }

    func testServerProfileJSONExtendsSingleAffinityBucket() throws {
        // Golden fixture in the exact shape the server writes
        // (learning.ts: lowercase affinity keys). A local apply must
        // extend that bucket, never start a parallel mixed-case one.
        let json = #"{"id":"learning","affinities":{"petcare":{"score":-0.3,"accepts":0,"declines":2,"ignores":0,"updatedAt":"2026-11-10T07:00:00.000Z"}},"skillAffinities":{},"rateSensitivity":0,"distanceSensitivity":0,"reasonCounts":{"notMyThing":1},"tooLowDeclines":0,"eventCount":2,"updatedAt":"2026-11-10T07:00:00.000Z"}"#
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = HyggeISO8601.dateDecodingStrategy
        var profile = try decoder.decode(LearningProfile.self, from: Data(json.utf8))
        XCTAssertEqual(profile.affinity(for: .petCare), -0.3, accuracy: 1e-9)
        profile.apply(FeedbackEvent(subjectType: .opportunity, subjectId: "local-1",
                                    action: .declined, reason: .other, category: .petCare,
                                    occurredAt: Date(timeIntervalSince1970: 1_800_000_000)))
        XCTAssertEqual(profile.affinities.count, 1, "one bucket per category across server and device")
        XCTAssertNotNil(profile.affinities["petcare"])
        XCTAssertNil(profile.affinities["petCare"])
        XCTAssertEqual(profile.affinity(for: .petCare), -0.5, accuracy: 1e-9, "server score and local decline accumulate")
        XCTAssertEqual(profile.affinities["petcare"]?.declines, 3)
    }

    func testBeliefKindsStatedNeverDecaysInferredExpires() {
        var book = BeliefBook()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let old = now.addingTimeInterval(-90 * 86_400)
        book.beliefs.append(Belief(sentence: "Has a car", source: .youSaidIt, learnedAt: old, confidence: 0.9))
        book.pending.append(Belief(sentence: "Prefers close work", source: .learnedFromWork, learnedAt: old, confidence: 0.8))
        XCTAssertEqual(book.kind(of: book.beliefs[0]), .stated)
        XCTAssertEqual(book.kind(of: book.pending[0]), .inferred)
        XCTAssertEqual(book.effectiveConfidence(of: book.beliefs[0], at: now), 0.9, accuracy: 1e-9)
        XCTAssertEqual(book.effectiveConfidence(of: book.pending[0], at: now), 0.1, accuracy: 1e-9)
        XCTAssertTrue(book.isExpired(book.pending[0], at: now))
        book.pruneExpired(at: now)
        XCTAssertTrue(book.pending.isEmpty)
        XCTAssertEqual(book.beliefs.count, 1, "stated beliefs are never pruned")

        // Confirming a belief makes it stated (confirmed in the hub).
        book.propose(sentence: "Likes mornings", source: .guessedFromChat, confidence: 0.6)
        let pending = book.pending[0]
        XCTAssertEqual(book.kind(of: pending), .inferred)
        book.confirm(proposalID: pending.id)
        XCTAssertEqual(book.kind(of: book.beliefs.last!), .stated)
    }

    func testServerRankOrderIgnoresLocalScore() {
        func opp(_ title: String, category: OpportunityCategory, rank: Double?) -> Opportunity {
            Opportunity(siteID: "rover", title: title, summary: "", category: category,
                        payLabel: "", estimatedHourly: 60, locationLabel: "Leeds",
                        isRemote: true, requiredSkills: [], urlString: "", rankScore: rank)
        }
        // The locally stronger match (the pet-care one) has the lower
        // server score: feed order must follow the server score only.
        let lowLocalHighServer = opp("Server first", category: .freelance, rank: 0.9)
        let highLocalLowServer = opp("Server second", category: .petCare, rank: 0.5)
        let ordered = MatchEngine.inServerRankOrder(
            profile: petProfile(), opportunities: [highLocalLowServer, lowLocalHighServer])
        XCTAssertEqual(ordered.map { $0.0.title }, ["Server first", "Server second"])
        XCTAssertGreaterThan(ordered[1].1.score, ordered[0].1.score,
                             "display scores may disagree with feed order — that is the point")
    }

    func testFeedbackAndLearningRoundTripThroughExport() throws {
        let event = FeedbackEvent(subjectType: .opportunity, subjectId: "ignored only ids are strings",
                                  action: .ignored, category: .petCare,
                                  occurredAt: Date(timeIntervalSince1970: 1_800_000_000))
        let ignored = FeedbackEvent(id: "ignored:abc-123", subjectType: .opportunity,
                                    subjectId: "abc-123", action: .ignored, category: .petCare,
                                    occurredAt: event.occurredAt)
        let rebuilt = LearningProfile.rebuilt(from: [ignored])
        let export = ServerExport(
            feedbackEvents: [StateRow(id: ignored.id, updatedAt: "2026-11-01T00:00:00Z", data: ignored)],
            learningProfiles: [StateRow(id: "learning", updatedAt: "2026-11-01T00:00:00Z", data: rebuilt)])
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(ServerExport.self, from: encoder.encode(export))
        XCTAssertEqual(decoded.feedbackEvents.first?.data, ignored)
        XCTAssertEqual(decoded.learningProfiles.first?.data.affinity(for: .petCare) ?? -999, -0.05, accuracy: 1e-9)
        // Older exports without the learning sections still decode.
        let legacy = try decoder.decode(ServerExport.self, from: Data(#"{"counts":{},"hasRealFeedItem":false}"#.utf8))
        XCTAssertTrue(legacy.feedbackEvents.isEmpty && legacy.learningProfiles.isEmpty)
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

    // MARK: - Identity (Brief 00)

    func testAuthEmailNormalizationAndPolicy() {
        XCTAssertEqual(HyggeAuth.normalizeEmail("  Sam@Example.COM "), "sam@example.com")
        XCTAssertTrue(HyggeAuth.isPlausibleEmail("sam@example.com"))
        XCTAssertFalse(HyggeAuth.isPlausibleEmail("sam@"))
        XCTAssertFalse(HyggeAuth.isPlausibleEmail("not an email"))
        XCTAssertNil(HyggeAuth.passwordProblem("1234567890"))
        XCTAssertNotNil(HyggeAuth.passwordProblem("short"))
    }

    func testPrivateRelayIsDetectedAndNeverRemovableLogic() {
        XCTAssertTrue(HyggeAuth.isPrivateRelayEmail("abc@privaterelay.appleid.com"))
        XCTAssertFalse(HyggeAuth.isPrivateRelayEmail("sam@example.com"))
        XCTAssertFalse(HyggeAuth.isPrivateRelayEmail(nil))
        // Last login method can never be removed (never orphan an account).
        XCTAssertFalse(HyggeAuth.canRemoveLoginMethod(methodCount: 1))
        XCTAssertTrue(HyggeAuth.canRemoveLoginMethod(methodCount: 2))
    }

    func testAuthGateRouting() {
        // New user: carousel first, then sign-in, then onboarding, then home.
        XCTAssertEqual(AuthGate.resolve(hasSeenCarousel: false, hasOnboarded: false, isSignedIn: false, authRequired: true), .carousel)
        XCTAssertEqual(AuthGate.resolve(hasSeenCarousel: true, hasOnboarded: false, isSignedIn: false, authRequired: true), .auth)
        XCTAssertEqual(AuthGate.resolve(hasSeenCarousel: true, hasOnboarded: false, isSignedIn: true, authRequired: true), .onboarding)
        XCTAssertEqual(AuthGate.resolve(hasSeenCarousel: true, hasOnboarded: true, isSignedIn: true, authRequired: true), .home)
        // Signed-out returning user goes back through sign-in.
        XCTAssertEqual(AuthGate.resolve(hasSeenCarousel: true, hasOnboarded: true, isSignedIn: false, authRequired: true), .auth)
        // Debug builds without required cloud keep the legacy flow.
        XCTAssertEqual(AuthGate.resolve(hasSeenCarousel: true, hasOnboarded: false, isSignedIn: false, authRequired: false), .onboarding)
        XCTAssertEqual(AuthGate.resolve(hasSeenCarousel: false, hasOnboarded: true, isSignedIn: false, authRequired: false), .home)
    }

    func testLegacyTokenMigrationDecision() {
        XCTAssertTrue(SessionTokenStorage.shouldMigrateLegacyToken(
            storedToken: "tok", storedBaseURL: "https://api-staging.usehygge.app"))
        XCTAssertFalse(SessionTokenStorage.shouldMigrateLegacyToken(
            storedToken: "tok", storedBaseURL: "http://127.0.0.1:8787"),
            "a token paired with the retired local backend is dropped, not migrated")
        XCTAssertFalse(SessionTokenStorage.shouldMigrateLegacyToken(storedToken: "", storedBaseURL: nil))
        XCTAssertFalse(SessionTokenStorage.shouldMigrateLegacyToken(storedToken: nil, storedBaseURL: nil))
    }

    // MARK: - Brief 01 server-side state

    private func opportunity(_ title: String, demo: Bool) -> Opportunity {
        Opportunity(siteID: "rover", title: title, summary: "", category: .petCare,
                    payLabel: "$30/hr", estimatedHourly: 30, locationLabel: "Leeds",
                    isRemote: false, requiredSkills: [], urlString: "https://rover.com/x", isDemo: demo)
    }

    /// Demo items show only until the first real item exists (locally
    /// or on the server), and never upload.
    func testDemoItemsHideOnceRealItemExists() {
        let demo = opportunity("Demo", demo: true)
        let real = opportunity("Real", demo: false)
        XCTAssertEqual(StateSync.visibleOpportunities([demo], serverHasReal: false).map(\.title), ["Demo"])
        XCTAssertEqual(StateSync.visibleOpportunities([demo, real], serverHasReal: false).map(\.title), ["Real"])
        XCTAssertEqual(StateSync.visibleOpportunities([demo], serverHasReal: true).count, 0)
        XCTAssertEqual(StateSync.uploadableOpportunities([demo, real]).map(\.title), ["Real"])
    }

    /// Server wins on newest timestamp; a fresh install (empty local)
    /// resolves to exactly the server's feed/messages/profile rows.
    func testMergeServerWinsAndFreshInstallMatches() {
        let older = opportunity("Older title", demo: false)
        var newer = older
        newer.title = "Newer title"
        let merged = StateSync.mergeByID(
            local: [(value: older, updatedAt: "2026-10-31T10:00:00Z")],
            server: [(value: newer, updatedAt: "2026-10-31T11:00:00Z")],
            id: { $0.id.uuidString })
        XCTAssertEqual(merged.map(\.title), ["Newer title"])
        let fresh = StateSync.mergeByID(local: [], server: [(value: newer, updatedAt: "2026-10-31T11:00:00Z")],
                                        id: { $0.id.uuidString })
        XCTAssertEqual(fresh, [newer])
        XCTAssertFalse(StateSync.shouldApply(existingUpdatedAt: "2026-10-31T11:00:00Z",
                                             incomingUpdatedAt: "2026-10-31T10:00:00Z"))
    }

    /// Offline writes never claim to be saved; under require-cloud
    /// they fail honestly.
    func testOfflineWriteFailsHonestly() {
        XCTAssertEqual(OfflineWritePolicy.outcome(reachable: true, requireCloud: true), .savedToServer)
        XCTAssertEqual(OfflineWritePolicy.outcome(reachable: false, requireCloud: true), .failedUnreachable)
        XCTAssertFalse(OfflineWritePolicy.outcome(reachable: false, requireCloud: true).claimsSaved)
        XCTAssertFalse(OfflineWritePolicy.outcome(reachable: false, requireCloud: false).claimsSaved)
    }

    /// Migration payload drops demo items, cannot carry a secret, and
    /// its expected counts verify against server counts (twice = same).
    func testImportPayloadAndVerification() throws {
        let payload = ServerImport(
            profile: petProfile(), hasOnboarded: true, isPaused: false, lastVisitAt: nil,
            sites: [SeedSites.site(id: "rover")!], siteMemory: SiteMemoryRepository(),
            credentialRefs: [CredentialRef(domain: "rover.com", username: "sam@example.com")],
            opportunities: [opportunity("Real", demo: false), opportunity("Demo", demo: true)],
            tasks: [], applications: [], proposals: [], accountStates: ["rover": .watching],
            chatTranscript: [ChatEntry(fromAgent: false, text: "Hej")],
            activityEvents: [], beliefs: BeliefBook(), searchEvidence: [])
        XCTAssertEqual(payload.opportunities.map(\.title), ["Real"])
        let json = String(data: try JSONEncoder().encode(payload), encoding: .utf8)!.lowercased()
        XCTAssertFalse(json.contains("\"secret\""))
        XCTAssertFalse(json.contains("\"password\""))
        let expected = StateSync.expectedImportCounts(payload)
        XCTAssertTrue(StateSync.importMismatches(expected: expected, serverCounts: expected).isEmpty)
        XCTAssertFalse(StateSync.importMismatches(expected: expected, serverCounts: [:]).isEmpty)
    }

    /// Every StoreSnapshot field maps to a server endpoint/table.
    func testSnapshotAuditMappingIsComplete() {
        XCTAssertEqual(StateSync.unmappedSnapshotFields, [])
        XCTAssertTrue(StateSync.snapshotMapping.allSatisfy { !$0.endpoint.isEmpty && !$0.table.isEmpty })
    }

    /// Export JSON decodes into the same models the app renders.
    func testServerExportRoundTrips() throws {
        let profileRow = StateRow(id: "profile", updatedAt: "2026-10-31T11:00:00Z",
                                  data: ProfileState(profile: petProfile(), hasOnboarded: true, isPaused: false, lastVisitAt: nil))
        let export = ServerExport(profile: profileRow,
                                  messages: [StateRow(id: "m1", updatedAt: "2026-10-31T11:00:00Z",
                                                      data: ChatEntry(fromAgent: true, text: "Hej"))],
                                  accountStates: ["rover": .watching],
                                  counts: ["messages": 1], hasRealFeedItem: true)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(ServerExport.self, from: encoder.encode(export))
        XCTAssertEqual(decoded.profile?.data.profile.displayName, "Sam")
        XCTAssertEqual(decoded.messages.first?.data.text, "Hej")
        XCTAssertTrue(decoded.hasRealFeedItem)
    }

    /// Tile labels must fit a two-column tile whole — no hyphenated truncation.
    func testTileLabelsFit() {
        for category in OpportunityCategory.allCases {
            XCTAssertFalse(category.tileLabel.isEmpty)
            XCTAssertLessThanOrEqual(category.tileLabel.count, 12, "\(category) tile label too long")
            XCTAssertFalse(category.activityLabel.isEmpty)
        }
    }

    // MARK: - Brief 03: trusted sessions & 2FA handoff

    /// After the user completes a human check, resume() re-approves the
    /// same task in place; approve() must still refuse from needsHuman,
    /// and a task still waiting on answers cannot resume past them.
    func testResumeAfterHumanCheck() throws {
        var task = AgentTask(kind: .apply, siteID: "rover.com", targetURLString: "https://rover.com",
                             goal: "apply", title: "Apply", browserSessionID: "kept-session",
                             status: .needsHuman)
        XCTAssertThrowsError(try task.approve())
        try task.resume()
        XCTAssertEqual(task.status, .approved)
        XCTAssertEqual(task.browserSessionID, "kept-session") // resume carries the same session

        var asking = AgentTask(kind: .signup, siteID: "rover.com", targetURLString: "https://rover.com",
                               goal: "join", title: "Join", informationRequests: ["Phone?"],
                               status: .needsHuman)
        XCTAssertThrowsError(try asking.resume())

        var fresh = AgentTask(kind: .discover, siteID: "rover.com", targetURLString: "https://rover.com",
                              goal: "look", title: "Look")
        XCTAssertThrowsError(try fresh.resume())
    }

    /// Tasks saved before browserSessionID existed must still decode.
    func testAgentTaskDecodesWithoutBrowserSessionID() throws {
        let legacy = """
        {"id":"00000000-0000-0000-0000-000000000001","kind":"discover","siteID":"rover.com",
         "targetURLString":"https://rover.com","goal":"look","title":"Look","draftedPayload":{},
         "browserTrace":[],"informationRequests":[],"status":"awaitingApproval","log":[],
         "createdAt":730000000}
        """
        let task = try JSONDecoder().decode(AgentTask.self, from: Data(legacy.utf8))
        XCTAssertNil(task.browserSessionID)
        let reencoded = try JSONDecoder().decode(AgentTask.self, from: JSONEncoder().encode(task))
        XCTAssertEqual(reencoded, task)
    }

    // MARK: - Brief 04 Hygge email (receive only)

    func testHyggeEmailAddressValidation() {
        XCTAssertEqual(HyggeEmail.digits(from: "4839201847@usehygge.cc"), "4839201847")
        XCTAssertEqual(HyggeEmail.digits(from: " 4839201847@UseHygge.CC "), "4839201847")
        XCTAssertNil(HyggeEmail.digits(from: "sam@usehygge.cc"))
        XCTAssertNil(HyggeEmail.digits(from: "483920184@usehygge.cc"))
        XCTAssertNil(HyggeEmail.digits(from: "4839201847@example.com"))
        XCTAssertTrue(HyggeEmail.isHyggeAddress("0123456789@usehygge.cc")) // leading zero allowed
        XCTAssertEqual(HyggeEmail.address(digits: "4839201847"), "4839201847@usehygge.cc")
        XCTAssertNil(HyggeEmail.address(digits: "sam"))
    }

    func testSiteSignupEmailChoiceDraft() {
        let hygge = SiteSignupEmailChoice.hygge.draftedPayload(
            signupEmail: "4839201847@usehygge.cc", displayName: "Sam")
        XCTAssertEqual(hygge["email"], "4839201847@usehygge.cc")
        XCTAssertEqual(hygge["emailChoice"], "hygge")
        XCTAssertEqual(hygge["awaitingEmailVerification"], "true")
        let own = SiteSignupEmailChoice.own.draftedPayload(
            signupEmail: " Sam@Example.com ", displayName: "Sam")
        XCTAssertEqual(own["email"], "sam@example.com")
        XCTAssertEqual(own["awaitingEmailVerification"], "false")
    }

    func testSignupTaskEmailChoice() {
        let site = SeedSites.all[0]
        let hyggeTask = AgentTaskFactory.signupTask(
            profile: petProfile(), site: site,
            emailChoice: .hygge, signupEmail: "4839201847@usehygge.cc")
        XCTAssertEqual(hyggeTask.draftedPayload["email"], "4839201847@usehygge.cc")
        XCTAssertTrue(hyggeTask.goal.contains("do not ask the user to open email"))
        let ownTask = AgentTaskFactory.signupTask(profile: petProfile(), site: site)
        XCTAssertEqual(ownTask.draftedPayload["emailChoice"], "own")
    }

    func testSuggestedSitePasswordsAreStrongAndVary() {
        let first = SitePasswordSuggestion.generate()
        let second = SitePasswordSuggestion.generate()
        XCTAssertEqual(first.count, SitePasswordSuggestion.length)
        XCTAssertTrue(SitePasswordSuggestion.isStrong(first))
        XCTAssertNotEqual(first, second)
        XCTAssertFalse(SitePasswordSuggestion.isStrong("correct horse battery"))
    }

    func testFiledEmailAndAddressDecode() throws {
        let addressJSON = #"{"hyggeEmail":{"address":"4839201847@usehygge.cc","digits":"4839201847","createdAt":"2026-10-31T10:00:00.000Z"}}"#
        let address = try JSONDecoder().decode(HyggeEmailAddressResponse.self, from: Data(addressJSON.utf8))
        XCTAssertEqual(address.hyggeEmail?.address, "4839201847@usehygge.cc")
        let noneJSON = #"{"hyggeEmail":null}"#
        XCTAssertNil(try JSONDecoder().decode(HyggeEmailAddressResponse.self, from: Data(noneJSON.utf8)).hyggeEmail)

        let filedJSON = #"{"id":"m1","sender":"Rover","senderDomain":"rover.com","subject":"New request","date":null,"kind":"other","summary":"A summary","actionableItems":["Link to rover.com"],"attachments":[{"filename":"a.pdf","contentType":"application/pdf","size":10}],"filedAt":"2026-10-31"}"#
        let filed = try JSONDecoder().decode(FiledEmailSummary.self, from: Data(filedJSON.utf8))
        XCTAssertEqual(filed.senderDomain, "rover.com")
        XCTAssertEqual(filed.attachments.first?.filename, "a.pdf")

        // Server-filed mail arrives as a filedEmail journal event.
        // Server timestamps carry fractional seconds, which the
        // plain .iso8601 strategy rejects on older OS releases —
        // the app decodes them through HyggeISO8601 instead.
        XCTAssertNotNil(HyggeISO8601.date(from: "2026-10-31T10:05:00.000Z"))
        XCTAssertNotNil(HyggeISO8601.date(from: "2026-10-31T10:05:00Z"))
        XCTAssertNil(HyggeISO8601.date(from: "31 Oct 2026"))
        let eventJSON = #"{"id":"00000000-0000-0000-0000-000000000001","occurredAt":"2026-10-31T10:05:00.000Z","kind":"filedEmail","sentence":"Filed mail from rover.com: Hi","detail":"summary","currencyCode":"USD","listingsChecked":0}"#
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = HyggeISO8601.dateDecodingStrategy
        let event = try decoder.decode(ActivityEvent.self, from: Data(eventJSON.utf8))
        XCTAssertEqual(event.kind, .filedEmail)
    }

    /// The helper's session-profile JSON decodes into metadata only.
    func testSessionProfileRefDecodesHelperShape() throws {
        let json = #"{"domain":"rover.com","trustSupport":"supported","hasProfile":true}"#
        let ref = try JSONDecoder().decode(SessionProfileRef.self, from: Data(json.utf8))
        XCTAssertEqual(ref.domain, "rover.com")
        XCTAssertEqual(ref.trustSupport, .supported)
        XCTAssertTrue(ref.hasProfile)
        XCTAssertEqual(ref.id, "rover.com")
    }

}
