#!/usr/bin/env python3
"""Fail a release before upload if the signed IPA cannot receive magic links."""
import plistlib
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


def validate_entitlements(actual, expected, bundle_id, profile):
    expected_app_id = f"3KA38L8A4F.{bundle_id}"
    if actual.get("application-identifier") != expected_app_id:
        raise ValueError("Signed app identifier does not match the Universal Link association.")
    if profile.get("application-identifier") != expected_app_id:
        raise ValueError("Provisioning profile does not match the app identifier.")
    domains = expected["com.apple.developer.associated-domains"]
    if not set(domains).issubset(actual.get("com.apple.developer.associated-domains", [])):
        raise ValueError("Signed app is missing required Universal Link entitlements.")
    allowed = profile.get("com.apple.developer.associated-domains", [])
    if "*" not in allowed and not set(domains).issubset(allowed):
        raise ValueError("Provisioning profile does not allow the required associated domains.")


def verify_ipa(path):
    root = Path(__file__).resolve().parent.parent
    expected = plistlib.loads((root / "App/Hygge-Release.entitlements").read_bytes())
    with tempfile.TemporaryDirectory(prefix="hygge-app-links-") as temp:
        with zipfile.ZipFile(path) as ipa:
            # Treat the archive as input; never allow extraction outside the temp folder.
            for name in ipa.namelist():
                if not (Path(temp) / name).resolve().is_relative_to(Path(temp).resolve()):
                    raise ValueError("IPA contains an invalid path.")
            ipa.extractall(temp)
        apps = list((Path(temp) / "Payload").glob("*.app"))
        if len(apps) != 1:
            raise ValueError("Expected exactly one app in the IPA.")
        app = apps[0]
        info = plistlib.loads((app / "Info.plist").read_bytes())
        if info.get("CFBundleIdentifier") != "app.usehygge":
            raise ValueError("IPA is not Hygge.")
        subprocess.run(["codesign", "--verify", "--strict", str(app)], check=True, capture_output=True)
        signed = subprocess.run(["codesign", "-d", "--entitlements", ":-", str(app)],
                                check=True, capture_output=True)
        actual = plistlib.loads(signed.stdout)
        decoded = subprocess.run(["security", "cms", "-D", "-i", str(app / "embedded.mobileprovision")],
                                 check=True, capture_output=True)
        profile = plistlib.loads(decoded.stdout)["Entitlements"]
        validate_entitlements(actual, expected, info["CFBundleIdentifier"], profile)
        print(f"PASS: Hygge {info['CFBundleVersion']} is signed for both magic-link domains.")


if __name__ == "__main__":
    try:
        verify_ipa(sys.argv[1])
    except (ValueError, KeyError, IndexError, OSError, subprocess.CalledProcessError) as error:
        # Never print a provisioning profile or signed payload on failure.
        print(f"FAIL: release Universal Link verification: {error}", file=sys.stderr)
        sys.exit(1)
