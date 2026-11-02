#!/usr/bin/env python3
"""Check the CI profile before archiving and the signed app before upload."""
from datetime import datetime, timezone
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
    for key, value in expected.items():
        if key == "com.apple.developer.associated-domains":
            continue
        if actual.get(key) != value:
            raise ValueError(f"Signed app is missing required capability: {key}.")
        if profile.get(key) != value:
            raise ValueError(f"Provisioning profile does not allow required capability: {key}.")


def validate_profile(profile, expected, now=None):
    expiration = profile.get("ExpirationDate")
    now = now or datetime.now(timezone.utc)
    if not isinstance(expiration, datetime) or expiration.replace(tzinfo=timezone.utc) <= now:
        raise ValueError("CI provisioning profile is expired or has no expiration date.")
    entitlements = profile["Entitlements"]
    if entitlements.get("get-task-allow") or profile.get("ProvisionedDevices") or profile.get("ProvisionsAllDevices"):
        raise ValueError("CI provisioning profile must be an App Store distribution profile.")
    # Validate all requested capabilities before invoking the archive command.
    validate_entitlements({"application-identifier": "3KA38L8A4F.app.usehygge", **expected},
                          expected, "app.usehygge", entitlements)


def expected_entitlements():
    root = Path(__file__).resolve().parent.parent
    return plistlib.loads((root / "App/Hygge-Release.entitlements").read_bytes())


def decode_profile(path):
    decoded = subprocess.run(["security", "cms", "-D", "-i", str(path)],
                             check=True, capture_output=True)
    return plistlib.loads(decoded.stdout)


def verify_profile(path):
    validate_profile(decode_profile(path), expected_entitlements())
    print("PASS: CI provisioning profile allows all required Hygge release capabilities.")


def verify_ipa(path):
    expected = expected_entitlements()
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
        profile = decode_profile(app / "embedded.mobileprovision")
        validate_profile(profile, expected)
        validate_entitlements(actual, expected, info["CFBundleIdentifier"], profile["Entitlements"])
        print(f"PASS: Hygge {info['CFBundleVersion']} is signed for magic links, notifications and Apple sign-in.")


if __name__ == "__main__":
    try:
        if sys.argv[1] == "--profile":
            verify_profile(sys.argv[2])
        else:
            verify_ipa(sys.argv[1])
    except (ValueError, KeyError, IndexError, OSError, subprocess.CalledProcessError) as error:
        # Never print a provisioning profile or signed payload on failure.
        print(f"FAIL: release capability verification: {error}", file=sys.stderr)
        sys.exit(1)
