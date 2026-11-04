import XCTest
@testable import HyggeCore

/// The one "Check your email" page (2026-11-04): shared copy and
/// rules for every emailed-link scenario, kept pure so the page
/// cannot drift back into per-screen captions.
final class MagicLinkPageTests: XCTestCase {

    func testArrivalKeepsActiveFlowPurpose() {
        // A link tapped mid-sign-up must be consumed in place as a
        // sign-up, never re-routed as a returning sign-in (that swap
        // destroyed the onboarding conversation and its answers).
        XCTAssertEqual(
            MagicLinkPageCopy.arrivalPurpose(isSignedIn: false, activePurpose: .signUp), .signUp)
        XCTAssertEqual(
            MagicLinkPageCopy.arrivalPurpose(isSignedIn: true, activePurpose: .addEmail), .addEmail)
        // No flow on screen (cold launch from the mail tap): signed
        // in means the link adds email sign-in; signed out it's a
        // plain sign-in.
        XCTAssertEqual(
            MagicLinkPageCopy.arrivalPurpose(isSignedIn: true, activePurpose: nil), .addEmail)
        XCTAssertEqual(
            MagicLinkPageCopy.arrivalPurpose(isSignedIn: false, activePurpose: nil), .signIn)
    }

    func testResendCooldownCountsDownFromThirty() {
        let sent = Date(timeIntervalSinceReferenceDate: 1_000)
        XCTAssertEqual(MagicLinkPageCopy.resendSecondsRemaining(sentAt: sent, now: sent), 30)
        XCTAssertEqual(
            MagicLinkPageCopy.resendSecondsRemaining(sentAt: sent, now: sent.addingTimeInterval(6)), 24)
        XCTAssertEqual(
            MagicLinkPageCopy.resendSecondsRemaining(sentAt: sent, now: sent.addingTimeInterval(30)), 0)
        XCTAssertEqual(
            MagicLinkPageCopy.resendSecondsRemaining(sentAt: sent, now: sent.addingTimeInterval(95)), 0)
        XCTAssertEqual(MagicLinkPageCopy.resendLabel(secondsRemaining: 24), "Resend in 0:24")
        XCTAssertEqual(MagicLinkPageCopy.resendLabel(secondsRemaining: 5), "Resend in 0:05")
        XCTAssertEqual(MagicLinkPageCopy.resendLabel(secondsRemaining: 0), "Resend email")
    }

    func testPurposeCopy() {
        XCTAssertEqual(MagicLinkPageCopy.sentSentence(.signUp), "We sent a sign-in link to")
        XCTAssertEqual(MagicLinkPageCopy.sentSentence(.signIn), "We sent a sign-in link to")
        XCTAssertEqual(MagicLinkPageCopy.sentSentence(.addEmail), "We sent a sign-in link to")
        XCTAssertEqual(MagicLinkPageCopy.sentSentence(.password), "We sent a confirmation email to")
        XCTAssertTrue(MagicLinkPageCopy.tapSentence(.signUp).hasPrefix("Tap the link in that email to finish signing up."))
        XCTAssertTrue(MagicLinkPageCopy.tapSentence(.signIn).hasPrefix("Tap the link in that email to sign in."))
        XCTAssertTrue(MagicLinkPageCopy.tapSentence(.addEmail).hasPrefix("Tap the link in that email to add email sign-in."))
        XCTAssertTrue(MagicLinkPageCopy.tapSentence(.password).hasPrefix("Tap the link in that email to save your new password."))
        for purpose in [MagicLinkPurpose.signUp, .signIn, .addEmail, .password] {
            XCTAssertTrue(MagicLinkPageCopy.tapSentence(purpose).contains("15 minutes"))
        }
        XCTAssertEqual(MagicLinkPageCopy.workingText(.signUp), "Signing you in…")
        XCTAssertEqual(MagicLinkPageCopy.workingText(.password), "Saving your password…")
        // Only settings scenarios get a Done screen; sign-in success
        // goes straight Home.
        XCTAssertNil(MagicLinkPageCopy.doneTitle(.signUp))
        XCTAssertNil(MagicLinkPageCopy.doneTitle(.signIn))
        XCTAssertEqual(MagicLinkPageCopy.doneTitle(.addEmail), "Email sign-in added")
        XCTAssertEqual(MagicLinkPageCopy.doneTitle(.password), "Password saved")
    }
}
