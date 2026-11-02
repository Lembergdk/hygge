import runpy
import unittest
from pathlib import Path

validate = runpy.run_path(str(Path(__file__).with_name("check-release-app-links.py")))["validate_entitlements"]
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


if __name__ == "__main__":
    unittest.main()
