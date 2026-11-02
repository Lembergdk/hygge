import runpy
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

checks = runpy.run_path(str(Path(__file__).with_name("check-release-app-links.py")))
validate = checks["validate_entitlements"]
KEY = "com.apple.developer.associated-domains"
APP = "3KA38L8A4F.app.usehygge"
DOMAINS = ["applinks:api.usehygge.app", "applinks:api-staging.usehygge.app"]


class ReleaseAppLinksTests(unittest.TestCase):
    def setUp(self):
        self.actual = {"application-identifier": APP, KEY: DOMAINS.copy()}
        self.expected = {KEY: DOMAINS.copy()}
        self.profile = {"application-identifier": APP, KEY: ["*"]}

    def check(self):
        validate(self.actual, self.expected, "app.usehygge", self.profile)

    def test_wildcard_or_explicit_profile_supports_both_domains(self):
        self.check()
        self.profile[KEY] = DOMAINS.copy()
        self.check()

    def test_signed_app_must_have_both_domains_even_with_a_wildcard_profile(self):
        self.actual[KEY] = DOMAINS[:1]
        with self.assertRaisesRegex(ValueError, "missing required"):
            self.check()
        self.actual.pop(KEY)
        with self.assertRaisesRegex(ValueError, "missing required"):
            self.check()

    def test_profile_must_allow_associated_domains(self):
        self.profile.pop(KEY)
        with self.assertRaisesRegex(ValueError, "does not allow"):
            self.check()

    def test_other_app_or_team_fails(self):
        self.actual["application-identifier"] = "OTHER.app.usehygge"
        with self.assertRaisesRegex(ValueError, "Signed app identifier"):
            self.check()
        self.actual["application-identifier"] = APP
        self.profile["application-identifier"] = "OTHER.app.usehygge"
        with self.assertRaisesRegex(ValueError, "Provisioning profile"):
            self.check()

    def test_push_and_apple_sign_in_must_match_in_app_and_profile(self):
        for key, value in [("aps-environment", "production"), ("com.apple.developer.applesignin", ["Default"])]:
            with self.subTest(key=key):
                self.expected[key] = value
                self.actual[key] = value
                with self.assertRaisesRegex(ValueError, "Provisioning profile does not allow required capability"):
                    self.check()
                self.profile[key] = value
                self.check()
                self.actual.pop(key)
                with self.assertRaisesRegex(ValueError, "Signed app is missing required capability"):
                    self.check()
                self.actual[key] = value

    def test_preflight_accepts_valid_distribution_profile(self):
        profile = {"ExpirationDate": datetime.now(timezone.utc) + timedelta(days=1),
                   "Entitlements": {**self.profile, "get-task-allow": False}}
        checks["validate_profile"](profile, self.expected)

    def test_preflight_rejects_expired_and_non_store_profiles(self):
        now = datetime.now(timezone.utc)
        profile = {"ExpirationDate": now - timedelta(days=1), "Entitlements": self.profile.copy()}
        with self.assertRaisesRegex(ValueError, "expired"):
            checks["validate_profile"](profile, self.expected, now)
        profile["ExpirationDate"] = now + timedelta(days=1)
        for field, value in [("ProvisionedDevices", ["test-device"]), ("ProvisionsAllDevices", True)]:
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "App Store"):
                checks["validate_profile"]({**profile, field: value}, self.expected, now)
        profile["Entitlements"]["get-task-allow"] = True
        with self.assertRaisesRegex(ValueError, "App Store"):
            checks["validate_profile"](profile, self.expected, now)

    def test_preflight_rejects_the_stale_profile_without_app_capabilities(self):
        expected = {KEY: DOMAINS, "aps-environment": "production", "com.apple.developer.applesignin": ["Default"]}
        profile = {"ExpirationDate": datetime.now(timezone.utc) + timedelta(days=1),
                   "Entitlements": {"application-identifier": APP}}
        with self.assertRaisesRegex(ValueError, "associated domains"):
            checks["validate_profile"](profile, expected)


if __name__ == "__main__":
    unittest.main()
