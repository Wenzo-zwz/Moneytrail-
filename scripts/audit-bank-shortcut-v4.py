"""Audit signed public iCloud shares against the v4 Shortcuts sources."""

import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import re
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]
SHARE_URL = re.compile(r"https://www\.icloud\.com/shortcuts/([0-9a-fA-F]{32})")


def read_url(url, host_allowed, limit=1_000_000):
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not host_allowed(parsed.hostname or ""):
        raise ValueError("Unexpected iCloud download host")
    with urlopen(url, timeout=20) as response:
        final = urlsplit(response.geturl())
        if final.scheme != "https" or not host_allowed(final.hostname or ""):
            raise ValueError("Unexpected iCloud redirect host")
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError("iCloud download exceeds the audit size limit")
    return data


def normalize_actions(workflow):
    """Match action order and references even when Apple reissues action UUIDs."""
    actions = workflow["WFWorkflowActions"]
    ids = {}
    groups = {}
    for index, action in enumerate(actions):
        params = action["WFWorkflowActionParameters"]
        if "UUID" in params:
            if params["UUID"] in ids:
                raise ValueError("Duplicate action UUID")
            ids[params["UUID"]] = index
        if "GroupingIdentifier" in params:
            groups.setdefault(params["GroupingIdentifier"], index)

    def normalize(value):
        if isinstance(value, list):
            return [normalize(entry) for entry in value]
        if not isinstance(value, dict):
            return value
        result = {}
        for key, item in value.items():
            if key == "OutputUUID":
                if item not in ids:
                    raise ValueError("Unresolved action reference")
                result[key] = ids[item]
            elif key == "GroupingIdentifier":
                result[key] = groups[item]
            elif key != "OutputName" or value.get("Type") != "ActionOutput":
                result[key] = normalize(item)
        return result

    normalized = []
    for action in actions:
        identifier = action["WFWorkflowActionIdentifier"]
        params = {key: value for key, value in action["WFWorkflowActionParameters"].items() if key != "UUID"}
        if identifier == "is.workflow.actions.text.match":
            params.setdefault("WFMatchTextCaseSensitive", False)
        if identifier == "is.workflow.actions.downloadurl":
            params.setdefault("WFHTTPMethod", "GET")
        normalized.append((identifier, normalize(params)))
    return normalized


def compare_workflows(exported, expected, *, allow_default_search_visibility=False):
    # Reject the private file parameters even if their provider metadata is unfamiliar.
    for item in exported["WFWorkflowActions"]:
        params = item["WFWorkflowActionParameters"]
        if "WFFile" in params or "WFFolder" in params:
            raise ValueError("The shared shortcut has a selected folder. Share the portable copy.")
    compact = plistlib.dumps(exported, fmt=plistlib.FMT_XML)
    if b"deviceSpecific:" in compact or b"crossDeviceItemID" in compact or b"mt_sms_" in compact:
        raise ValueError("The shared shortcut contains a personal folder reference or token")
    for field in ("WFWorkflowImportQuestions", "WFWorkflowInputContentItemClasses", "WFWorkflowHasShortcutInputVariables"):
        if exported.get(field) != expected.get(field):
            raise ValueError(f"The shared shortcut changes {field}")
    exported_types = exported.get("WFWorkflowTypes", [])
    source_types = expected.get("WFWorkflowTypes", [])
    # Mac sharing adds Watch visibility and may enable search for the folder-free shortcut.
    allowed_types = [source_types, ["Watch", *source_types]]
    if allow_default_search_visibility and not source_types:
        allowed_types.append(["Watch", "WFWorkflowTypeShowInSearch"])
    if exported_types not in allowed_types:
        raise ValueError("The shared shortcut changes WFWorkflowTypes")
    actual = normalize_actions(exported)
    intended = normalize_actions(expected)
    if len(actual) != len(intended):
        raise ValueError("The shared shortcut action count differs from the portable source")
    for index, (left, right) in enumerate(zip(actual, intended, strict=True), 1):
        if left != right:
            raise ValueError(f"Action {index} differs from the portable source; review the Apple export")


def audit(url, source, expected_name=None):
    match = SHARE_URL.fullmatch(url)
    if match is None:
        raise ValueError("Use a complete https://www.icloud.com/shortcuts/... share link")
    record = json.loads(read_url(
        f"https://www.icloud.com/shortcuts/api/records/{match[1].lower()}", lambda host: host == "www.icloud.com"))
    fields = record["fields"]
    if expected_name is not None and fields["name"]["value"] != expected_name:
        raise ValueError(f"Name the shared shortcut {expected_name}")
    if fields["signingStatus"]["value"] != "APPROVED":
        raise ValueError("Apple has not approved the signed shortcut")
    def asset(key):
        return read_url(fields[key]["value"]["downloadURL"], lambda host: host.endswith(".icloud-content.com"))
    raw, signed = asset("shortcut"), asset("signedShortcut")
    if not signed.startswith(b"AEA1"):
        raise ValueError("Signed asset is missing the Apple archive header")
    expected = plistlib.loads(source.read_bytes()) if source.suffix == ".plist" else json.loads(source.read_text(encoding="utf-8"))
    compare_workflows(plistlib.loads(raw), expected, allow_default_search_visibility=source.suffix == ".plist")
    print(f"{source.name}: portable action graph verified; signed SHA-256 {hashlib.sha256(signed).hexdigest()}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sms_url")
    parser.add_argument("update_url", nargs="?")
    args = parser.parse_args()
    if args.update_url and args.sms_url.lower() == args.update_url.lower():
        parser.error("Provide two distinct iCloud shares")
    try:
        if args.update_url:
            audit(args.sms_url, ROOT / "shortcuts/moneytrail-bank-v4.template.json")
            audit(args.update_url, ROOT / "shortcuts/moneytrail-rule-update-v4.template.json")
        else:
            audit(args.sms_url, ROOT / "public/shortcuts/moneytrail-bank-sms-v4.unsigned.plist", "MoneyTrail 银行短信记账")
    except (OSError, URLError, KeyError, TypeError, ValueError, plistlib.InvalidFileException) as error:
        parser.exit(1, f"v4 audit failed: {error}\n")
