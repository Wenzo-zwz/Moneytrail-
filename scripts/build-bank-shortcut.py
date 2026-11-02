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


def build_bytes():
    """Validate public account-free source and serialize deterministic XML."""
    workflow = json.loads(SOURCE.read_text(encoding="utf-8"))
    profile = json.loads(PROFILE.read_text(encoding="utf-8"))
    actions = workflow["WFWorkflowActions"]
    if len(actions) != 25:
        raise ValueError("Expected the audited 25-action three-bank workflow")
    if actions[0]["WFWorkflowActionParameters"]["WFTextActionText"] != "":
        raise ValueError("The shared personal-token field must be blank")
    questions = workflow["WFWorkflowImportQuestions"]
    if len(questions) != 1 or questions[0]["ActionIndex"] != 0 or questions[0]["DefaultValue"] != "":
        raise ValueError("The blank per-user token import question must target action 0")
    if profile["supportedBanks"] != ["abc", "boc", "ccb"] or profile["cardKinds"] != ["debit", "credit"]:
        raise ValueError("Expected one template for both card kinds at the three selected banks")
    match = actions[4]["WFWorkflowActionParameters"]
    if actions[4]["WFWorkflowActionIdentifier"] != "is.workflow.actions.text.match" or match["WFMatchTextPattern"] != profile["matchPattern"]:
        raise ValueError("The public profile and workflow routing filter must agree")
    contents = json.dumps(workflow, ensure_ascii=False)
    if any(value in contents for value in ("mt_sms_", "owner_id", "user_id", "last4", "卡尾号", "工商银行")):
        raise ValueError("The three-bank shared source contains personal or out-of-scope fields")
    xml = plistlib.dumps(workflow, fmt=plistlib.FMT_XML, sort_keys=False)
    declaration, remainder = xml.split(b"\n", 1)
    return workflow, declaration + b"\n" + NOTICE + remainder


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Check committed XML against the JSON source without changing files")
    args = parser.parse_args()
    workflow, xml = build_bytes()
    if args.check:
        saved = OUTPUT.read_bytes()
        if saved != xml or plistlib.loads(saved) != workflow:
            parser.error("Unsigned XML differs from its JSON source; run the builder")
        print("Unsigned source matches the committed JSON and XML (25 actions).")
    else:
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT.write_bytes(xml)
        print("Built public/shortcuts/moneytrail-three-bank-v1.unsigned.plist (unsigned; Apple signing required).")


if __name__ == "__main__":
    main()
