"""Build unsigned Apple Shortcuts source using only the Python standard library.

Run `python scripts/build-bank-shortcut.py`; use `--check` in verification.
The XML output needs Apple signing before it can be installed on an iPhone.
This builder makes no network requests and does not sign or publish anything.
"""

import argparse
import json
from pathlib import Path
import plistlib


ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "shortcuts/moneytrail-three-bank.template.json"
PROFILE = ROOT / "public/shortcuts/three-bank-profile.json"
OUTPUT = ROOT / "public/shortcuts/moneytrail-three-bank-v1.unsigned.plist"
NOTICE = (
    b"<!-- UNSIGNED SOURCE: MoneyTrail ABC/BOC/CCB debit and credit template.\n"
    b"Apple signing is required before installation; this XML is not an installer. -->\n"
)
GENERAL_SOURCE = ROOT / "shortcuts/moneytrail-general-bank.template.json"
GENERAL_PROFILE = ROOT / "public/shortcuts/general-bank-profile.json"
GENERAL_OUTPUT = ROOT / "public/shortcuts/moneytrail-general-bank-v2.unsigned.plist"
GENERAL_NOTICE = (
    b"<!-- UNSIGNED SOURCE: MoneyTrail ABC/BOC/CCB/CMB debit and credit template.\n"
    b"Apple signing is required before installation; this XML is not an installer. -->\n"
)


def build_bytes(source=SOURCE, profile_path=PROFILE, notice=NOTICE, banks=None):
    """Validate public account-free source and serialize deterministic XML."""
    workflow = json.loads(source.read_text(encoding="utf-8"))
    profile = json.loads(profile_path.read_text(encoding="utf-8"))
    banks = banks or ["abc", "boc", "ccb"]
    actions = workflow["WFWorkflowActions"]
    if len(actions) != 25:
        raise ValueError("Expected the 25-action bank workflow")
    if actions[0]["WFWorkflowActionParameters"]["WFTextActionText"] != "":
        raise ValueError("The shared personal-token field must be blank")
    questions = workflow["WFWorkflowImportQuestions"]
    if len(questions) != 1 or questions[0]["ActionIndex"] != 0 or questions[0]["DefaultValue"] != "":
        raise ValueError("The blank per-user token import question must target action 0")
    if profile["supportedBanks"] != banks or profile["cardKinds"] != ["debit", "credit"]:
        raise ValueError("Expected one template for both card kinds at the selected banks")
    match = actions[4]["WFWorkflowActionParameters"]
    if actions[4]["WFWorkflowActionIdentifier"] != "is.workflow.actions.text.match" or match["WFMatchTextPattern"] != profile["matchPattern"]:
        raise ValueError("The public profile and workflow routing filter must agree")
    contents = json.dumps(workflow, ensure_ascii=False)
    if any(value in contents for value in ("mt_sms_", "owner_id", "user_id", "last4", "卡尾号", "工商银行")):
        raise ValueError("The shared bank source contains personal or out-of-scope fields")
    xml = plistlib.dumps(workflow, fmt=plistlib.FMT_XML, sort_keys=False)
    declaration, remainder = xml.split(b"\n", 1)
    return workflow, declaration + b"\n" + notice + remainder


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Check committed XML against the JSON source without changing files")
    args = parser.parse_args()
    for source, profile, output, notice, banks in [
        (SOURCE, PROFILE, OUTPUT, NOTICE, ["abc", "boc", "ccb"]),
        (GENERAL_SOURCE, GENERAL_PROFILE, GENERAL_OUTPUT, GENERAL_NOTICE, ["abc", "boc", "ccb", "cmb"]),
    ]:
        workflow, xml = build_bytes(source, profile, notice, banks)
        if args.check:
            saved = output.read_bytes()
            if saved != xml or plistlib.loads(saved) != workflow:
                parser.error(f"Unsigned XML differs from its JSON source: {output.name}; run the builder")
            print(f"Unsigned {output.name} matches its JSON source (25 actions).")
        else:
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(xml)
            print(f"Built {output.relative_to(ROOT)} (unsigned; Apple signing required).")


if __name__ == "__main__":
    main()
