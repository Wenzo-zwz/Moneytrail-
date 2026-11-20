"""Build unsigned Apple Shortcuts source using only the Python standard library.

Run `python scripts/build-bank-shortcut.py`; use `--check` in verification.
The XML output needs Apple signing before it can be installed on an iPhone.
This builder makes no network requests and does not sign or publish anything.
"""

import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import plistlib
import re
import subprocess


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
ACTIVITY_SOURCE = ROOT / "shortcuts/moneytrail-bank-activity.template.json"
ACTIVITY_PROFILE = ROOT / "public/shortcuts/bank-activity-profile.json"
ACTIVITY_OUTPUT = ROOT / "public/shortcuts/moneytrail-bank-activity-v3.unsigned.plist"
ACTIVITY_NOTICE = (
    b"<!-- UNSIGNED SOURCE: MoneyTrail ICBC/ABC/BOC/CCB/CMB income and expense template.\n"
    b"Apple signing is required before installation; this XML is not an installer. -->\n"
)
RULES_SOURCE = ROOT / "shortcuts/bank-rules.json"
RULES_OUTPUT = ROOT / "public/shortcuts/bank-rules.json"
RULES_TEXT_OUTPUT = ROOT / "public/shortcuts/bank-rules.txt"
RULE_KEYS = ("schemaVersion", "version", "minShortcutVersion", "projectUrl", "publishedAt", "matchPattern")
RULE_VERSION_MAX = 999_999_999  # The updater reserves 1_000_000_000 for an invalid existing cache.
RULE_TEXT_MAX = 16_000
V4_SOURCES = (
    (ROOT / "shortcuts/moneytrail-bank-v4.template.json", ROOT / "public/shortcuts/moneytrail-bank-v4.unsigned.plist", False),
    (ROOT / "shortcuts/moneytrail-rule-update-v4.template.json", ROOT / "public/shortcuts/moneytrail-rule-update-v4.unsigned.plist", True),
)
SMS_V4_OUTPUT = ROOT / "public/shortcuts/moneytrail-bank-sms-v4.unsigned.plist"
RULE_URL = "https://wenzo-zwz.github.io/Moneytrail-/shortcuts/bank-rules.txt"
V4_CACHE_PATH = "bank-rules-v4.txt"
# Independently reviewed local guard, including split OTP and dangerous control characters.
V4_GUARD_SHA256 = "3faf920994aef90c9a0133ae23887d44ed60987e2a9a89179843695214f6c099"


def build_rules_bytes():
    """Run shared schema and publisher regression checks with the project's Node 24 runtime."""
    command = ["node", str(ROOT / "scripts/validate-bank-rules.mjs"), str(RULES_SOURCE)]
    if RULES_OUTPUT.exists():
        command.append(str(RULES_OUTPUT))
    result = subprocess.run(
        command,
        check=True, capture_output=True, text=True, timeout=15,
    )
    print(result.stdout.strip())
    manifest = json.loads(RULES_SOURCE.read_text(encoding="utf-8"))
    if manifest["version"] > RULE_VERSION_MAX:
        raise ValueError("The published rule version exceeds the native updater's supported range")
    # The native precheck intentionally accepts this six-key order, independent of editor order.
    text = json.dumps({key: manifest[key] for key in RULE_KEYS}, ensure_ascii=False, indent=2) + "\n"
    if len(text.encode("utf-16-le")) // 2 > RULE_TEXT_MAX:
        raise ValueError("The serialized rule manifest exceeds the native 16000-character envelope")
    return text.encode("utf-8")


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
    forbidden = ["mt_sms_", "owner_id", "user_id", "last4", "卡尾号"]
    if "icbc" not in banks:
        forbidden.append("工商银行")
    if any(value in contents for value in forbidden):
        raise ValueError("The shared bank source contains personal or out-of-scope fields")
    if "icbc" in banks and (profile.get("transactionKinds") != ["expense", "income"] or profile.get("incomeReviewOnly") is not True):
        raise ValueError("The five-bank activity profile must keep income review-only")
    xml = plistlib.dumps(workflow, fmt=plistlib.FMT_XML, sort_keys=False)
    declaration, remainder = xml.split(b"\n", 1)
    return workflow, declaration + b"\n" + notice + remainder


def require(condition, message):
    if not condition:
        raise ValueError(message)


def v4_envelope():
    string = r'"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4})){1,8000}"'
    project = re.escape("https://ojcgabicpjipwpvwolzn.supabase.co")
    fields = [r'"schemaVersion"\s*:\s*1', r'"version"\s*:\s*[1-9][0-9]{0,8}',
              r'"minShortcutVersion"\s*:\s*4', r'"projectUrl"\s*:\s*"' + project + r'"',
              r'"publishedAt"\s*:\s*"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z"',
              r'"matchPattern"\s*:\s*' + string]
    return r'^(?=[\s\S]{1,16000}(?![\s\S]))\s*\{\s*' + r'\s*,\s*'.join(fields) + r'\s*\}\s*(?![\s\S])'


def check_v4_flow(workflow):
    """Validate native references and retain branch contexts for the I/O safety checks."""
    raw = json.dumps(workflow, ensure_ascii=False)
    require(not re.search(r'"(?:WFFile|WFFolder|fileLocation|crossDeviceItemID|[^" ]*[Bb]ookmark[^" ]*)"\s*:', raw)
            and not any(s in raw for s in ('deviceSpecific:', 'mt_sms_', 'sb_secret_', 'service_role', 'Authorization')),
            "Portable v4 contains a device reference or private credential")
    allowed = {'gettext', 'setvariable', 'detect.text', 'detect.dictionary', 'text.match', 'conditional',
               'getvalueforkey', 'notification', 'number', 'documentpicker.open', 'documentpicker.save', 'downloadurl'}
    defined, names, stack, contexts = set(), set(), [], []
    def references(value):
        if isinstance(value, dict):
            if 'OutputUUID' in value:
                require(value.get('Type') == 'ActionOutput' and value['OutputUUID'] in defined,
                        'Unresolved v4 action output')
            if value.get('Type') == 'Variable' and 'VariableName' in value:
                require(value['VariableName'] in names, 'Unresolved v4 named variable')
            if value.get('WFSerializationType') == 'WFTextTokenString':
                token = value['Value']; encoded = token['string'].encode('utf-16-le')
                ranges = token.get('attachmentsByRange', {})
                require(len(ranges) == token['string'].count('\ufffc'), 'Unbound v4 text placeholder')
                for span in ranges:
                    match = re.fullmatch(r'\{([0-9]+), 1\}', span)
                    require(match is not None and encoded[2*int(match[1]):2*int(match[1])+2] == b'\xfc\xff', 'Invalid v4 token range')
            for child in value.values(): references(child)
        elif isinstance(value, list):
            for child in value: references(child)
    for action in workflow['WFWorkflowActions']:
        identifier = action['WFWorkflowActionIdentifier']; p = action['WFWorkflowActionParameters']
        require(identifier in {'is.workflow.actions.' + name for name in allowed}, 'Unexpected v4 action')
        contexts.append(tuple(stack)); references(p)
        mode = p.get('WFControlFlowMode')
        if mode is not None:
            require(identifier == 'is.workflow.actions.conditional', 'Only If actions may control branches')
            group = p['GroupingIdentifier']
            if mode == 0: stack.append((group, True))
            elif mode == 1:
                require(stack and stack[-1] == (group, True), 'Unpaired Otherwise'); stack[-1] = (group, False)
            elif mode == 2:
                require(stack and stack[-1][0] == group, 'Unpaired End If'); stack.pop()
            else: raise ValueError('Invalid control-flow mode')
        if 'UUID' in p:
            require(p['UUID'] not in defined, 'Duplicate v4 output'); defined.add(p['UUID'])
        if 'WFVariableName' in p: names.add(p['WFVariableName'])
    require(not stack, 'Unclosed v4 conditional')
    return contexts


def build_v4_bytes(source, updater):
    workflow = json.loads(source.read_text(encoding='utf-8')); contexts = check_v4_flow(workflow)
    actions = workflow['WFWorkflowActions']; p = [a['WFWorkflowActionParameters'] for a in actions]
    legacy_workflow = json.loads(ACTIVITY_SOURCE.read_text(encoding='utf-8')); legacy = legacy_workflow['WFWorkflowActions']
    require(len(actions) == 40, 'Expected the reviewed 40-action v4 workflow')
    def kind(index, name):
        require(actions[index]['WFWorkflowActionIdentifier'] == 'is.workflow.actions.' + name, 'v4 action type changed')
    def ref(value):
        if value.get('Type') == 'Variable' and 'Variable' in value: value = value['Variable']
        require(value.get('WFSerializationType') == 'WFTextTokenAttachment', 'Expected explicit v4 input')
        return value['Value']
    def token(value):
        require(value.get('WFSerializationType') == 'WFTextTokenString' and value['Value']['string'] == '\ufffc', 'Expected one v4 magic variable')
        return value['Value']['attachmentsByRange']['{0, 1}']
    def edge(index, origin, name):
        kind(index, name); require(ref(p[index]['WFInput'])['OutputUUID'] == p[origin]['UUID'], 'v4 input source changed')
    def condition(index, origin, code=100):
        edge(index, origin, 'conditional'); require(p[index]['WFCondition'] == code, 'v4 condition changed')
    def dictionary(index, origin, key):
        edge(index, origin, 'getvalueforkey'); require(p[index]['WFDictionaryKey'] == key, 'Wrong manifest field')
    def envelope(index, origin):
        kind(index, 'text.match')
        require(token(p[index]['text'])['OutputUUID'] == p[origin]['UUID'] and p[index]['WFMatchTextPattern'] == v4_envelope()
                and p[index]['WFMatchTextCaseSensitive'] is True, 'v4 envelope source or validation changed')
    def file(index, save=False):
        kind(index, 'documentpicker.save' if save else 'documentpicker.open')
        require(p[index]['WFFileDestinationPath' if save else 'WFGetFilePath'] == V4_CACHE_PATH, 'v4 cache paths differ')
        require((p[index]['WFAskWhereToSave'] is False and p[index]['WFSaveFileOverwrite'] is True) if save
                else p[index]['WFFileErrorIfNotFound'] is False, 'v4 file options changed')
    io = {name: [i for i, a in enumerate(actions) if a['WFWorkflowActionIdentifier'] == 'is.workflow.actions.' + name]
          for name in ('downloadurl', 'documentpicker.open', 'documentpicker.save')}
    require(io == ({'downloadurl': [0], 'documentpicker.open': [15], 'documentpicker.save': [30]} if updater
                   else {'downloadurl': [20], 'documentpicker.open': [8], 'documentpicker.save': []}), 'Unexpected v4 I/O')
    if not updater:
        require(actions[:4] == legacy[:4] and workflow['WFWorkflowImportQuestions'] == legacy_workflow['WFWorkflowImportQuestions'], 'Changed token or SMS input')
        require(actions[19:39] == legacy[5:], 'Changed original POST or status handling')
        kind(4, 'text.match'); condition(5, 4); kind(6, 'gettext')
        require(hashlib.sha256(p[4]['WFMatchTextPattern'].encode()).hexdigest() == V4_GUARD_SHA256
                and p[4]['WFMatchTextCaseSensitive'] is False and token(p[4]['text']) == {'Type': 'Variable', 'VariableName': '短信正文'}, 'Fixed local guard changed')
        require(p[6]['WFTextActionText'] == legacy[4]['WFWorkflowActionParameters']['WFMatchTextPattern'], 'Factory fallback must remain frozen v3')
        require([i for i, v in enumerate(p) if v.get('WFVariableName') == '选用规则'] == [7, 15], 'Untrusted selected-rule assignment')
        edge(7, 6, 'setvariable'); file(8); condition(9, 8); edge(10, 8, 'detect.text')
        envelope(11, 10); condition(12, 11); edge(13, 10, 'detect.dictionary'); dictionary(14, 13, 'matchPattern'); edge(15, 14, 'setvariable')
        require(contexts[15] == tuple((p[i]['GroupingIdentifier'], True) for i in (5, 9, 12)), 'Cache selection bypasses validation')
        route = deepcopy(actions[18]); require(token(p[18]['WFMatchTextPattern']) == {'Type': 'Variable', 'VariableName': '选用规则'}, 'Routing lost its selected rule')
        route['WFWorkflowActionParameters']['WFMatchTextPattern'] = legacy[4]['WFWorkflowActionParameters']['WFMatchTextPattern']
        require(route == legacy[4] and contexts[8] == ((p[5]['GroupingIdentifier'], True),)
                and contexts[20] == ((p[5]['GroupingIdentifier'], True), (p[19]['GroupingIdentifier'], True)), 'Guard or dynamic routing bypassed')
    else:
        require(not workflow['WFWorkflowImportQuestions'] and not workflow['WFWorkflowHasShortcutInputVariables'], 'Updater must not consume SMS input or tokens')
        require(p[0] == {'WFURL': RULE_URL, 'WFHTTPMethod': 'GET', 'UUID': p[0]['UUID']}, 'Updater GET must use its fixed public URL without credentials')
        edge(1, 0, 'detect.text'); envelope(2, 1); condition(3, 2); edge(4, 1, 'detect.dictionary'); dictionary(5, 4, 'matchPattern')
        for match, text, branch, sample in ((7, 6, 8, '测试消费1.00元【招商银行】。'), (10, 9, 11, '测试消费1.00元，验证码123456【招商银行】')):
            kind(match, 'text.match'); kind(text, 'gettext'); condition(branch, match)
            require(p[text]['WFTextActionText'] == sample and token(p[match]['WFMatchTextPattern'])['OutputUUID'] == p[5]['UUID']
                    and token(p[match]['text'])['OutputUUID'] == p[text]['UUID'] and p[match]['WFMatchTextCaseSensitive'] is False, 'Updater safety test changed')
        dictionary(14, 4, 'version'); file(15); condition(16, 15); edge(17, 15, 'detect.text'); envelope(18, 17); condition(19, 18)
        edge(20, 17, 'detect.dictionary'); dictionary(21, 20, 'version'); kind(24, 'number'); kind(27, 'number'); condition(29, 14, 2)
        require(p[24]['WFNumberActionNumber'] == str(RULE_VERSION_MAX + 1) and p[27]['WFNumberActionNumber'] == '0', 'Invalid/missing cache sentinels changed')
        require(ref(p[29]['WFInput']).get('Aggrandizements') == [{'Type': 'WFCoercionVariableAggrandizement', 'CoercionItemClass': 'WFNumberContentItem'}]
                and ref(p[29]['WFNumberValue'])['OutputUUID'] == p[28]['UUID'], 'Numeric version comparison changed')
        prefix = tuple((p[i]['GroupingIdentifier'], branch) for i, branch in ((3, True), (8, True), (11, False)))
        require(contexts[21] == prefix + ((p[16]['GroupingIdentifier'], True), (p[19]['GroupingIdentifier'], True))
                and contexts[24] == prefix + ((p[16]['GroupingIdentifier'], True), (p[19]['GroupingIdentifier'], False))
                and contexts[27] == prefix + ((p[16]['GroupingIdentifier'], False),)
                and p[25]['GroupingIdentifier'] == p[19]['GroupingIdentifier'] and p[28]['GroupingIdentifier'] == p[16]['GroupingIdentifier'], 'Current version selection changed')
        require(contexts[30] == prefix + ((p[29]['GroupingIdentifier'], True),), 'Save bypasses validation or strict newer-version check')
        file(30, save=True); edge(30, 1, 'documentpicker.save')
    xml = plistlib.dumps(workflow, fmt=plistlib.FMT_XML, sort_keys=False); declaration, remainder = xml.split(b'\n', 1)
    return workflow, declaration + b'\n<!-- UNSIGNED v4 SOURCE: Apple signing and first-run folder selection required. -->\n' + remainder


def build_sms_v4_bytes(validated_workflow):
    """Use the validated SMS workflow's built-in rule without reading a cache."""
    workflow = deepcopy(validated_workflow)
    actions = workflow["WFWorkflowActions"]
    builtin_rule = actions[6]["WFWorkflowActionParameters"]["WFTextActionText"]
    match = actions[18]
    match["WFWorkflowActionParameters"]["WFMatchTextPattern"] = builtin_rule
    workflow["WFWorkflowActions"] = actions[:6] + [match] + actions[19:]
    check_v4_flow(workflow)
    xml = plistlib.dumps(workflow, fmt=plistlib.FMT_XML, sort_keys=False)
    declaration, remainder = xml.split(b"\n", 1)
    return workflow, declaration + b"\n<!-- UNSIGNED SMS SOURCE: Apple signing is required before installation. -->\n" + remainder


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Check committed XML against the JSON source without changing files")
    args = parser.parse_args()
    try:
        rules = build_rules_bytes()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        parser.error(f"Bank rules validation failed: {getattr(error, 'stderr', '') or error}")
    for source, profile, output, notice, banks in [
        (SOURCE, PROFILE, OUTPUT, NOTICE, ["abc", "boc", "ccb"]),
        (GENERAL_SOURCE, GENERAL_PROFILE, GENERAL_OUTPUT, GENERAL_NOTICE, ["abc", "boc", "ccb", "cmb"]),
        (ACTIVITY_SOURCE, ACTIVITY_PROFILE, ACTIVITY_OUTPUT, ACTIVITY_NOTICE, ["icbc", "abc", "boc", "ccb", "cmb"]),
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
    for source, output, updater in V4_SOURCES:
        try:
            workflow, xml = build_v4_bytes(source, updater)
        except (KeyError, TypeError, ValueError) as error:
            parser.error(f"{source.name}: {error}")
        if args.check:
            if not output.exists() or output.read_bytes() != xml or plistlib.loads(xml) != workflow:
                parser.error(f"Unsigned XML differs from its JSON source: {output.name}; run the builder")
            print(f"Unsigned {output.name} matches its validated JSON source (40 actions).")
        else:
            output.write_bytes(xml)
            print(f"Built {output.relative_to(ROOT)} (unsigned; Apple signing and folder selection required).")
        if not updater:
            sms_workflow, sms_xml = build_sms_v4_bytes(workflow)
            if args.check:
                if not SMS_V4_OUTPUT.exists() or SMS_V4_OUTPUT.read_bytes() != sms_xml or plistlib.loads(sms_xml) != sms_workflow:
                    parser.error(f"Unsigned XML differs from the validated SMS actions: {SMS_V4_OUTPUT.name}; run the builder")
                print(f"Unsigned {SMS_V4_OUTPUT.name} matches the validated folder-free SMS workflow.")
            else:
                SMS_V4_OUTPUT.write_bytes(sms_xml)
                print(f"Built {SMS_V4_OUTPUT.relative_to(ROOT)} (unsigned; Apple signing required).")
    for output in (RULES_OUTPUT, RULES_TEXT_OUTPUT):
        if args.check:
            if not output.exists() or output.read_bytes() != rules:
                parser.error(f"{output.name} differs from the canonical manifest; run the builder")
            print(f"Public {output.name} matches the canonical manifest.")
        else:
            output.write_bytes(rules)
            print(f"Built {output.relative_to(ROOT)} (public rules data; not a shortcut installer).")


if __name__ == "__main__":
    main()
