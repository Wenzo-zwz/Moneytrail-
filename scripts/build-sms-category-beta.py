"""Build the separate, unsigned MoneyTrail SMS category confirmation beta."""

import argparse
from copy import deepcopy
import json
from pathlib import Path
import plistlib
import re
import runpy
from uuid import NAMESPACE_URL, uuid5


ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "public/shortcuts/moneytrail-bank-sms-category-beta.unsigned.plist"
PREFIX = "is.workflow.actions."
LATER = "稍后处理"


def action_id(name):
    return str(uuid5(NAMESPACE_URL, f"MoneyTrail SMS category beta/{name}")).upper()


def action(kind, **parameters):
    return {"WFWorkflowActionIdentifier": PREFIX + kind, "WFWorkflowActionParameters": parameters}


def output(source, name):
    return {"Type": "ActionOutput", "OutputUUID": source["WFWorkflowActionParameters"]["UUID"], "OutputName": name}


def attachment(value):
    return {"Value": value, "WFSerializationType": "WFTextTokenAttachment"}


def text_token(template, *outputs):
    value = {"string": template}
    positions = [len(template[:index].encode("utf-16-le")) // 2 for index, char in enumerate(template) if char == "\ufffc"]
    if outputs:
        value["attachmentsByRange"] = {f"{{{offset}, 1}}": result for offset, result in zip(positions, outputs, strict=True)}
    return {"Value": value, "WFSerializationType": "WFTextTokenString"}


def dictionary_value(source, name, key):
    return action("getvalueforkey", WFInput=attachment(output(source, name)), WFDictionaryKey=key, UUID=action_id(f"field/{key}"))


def branch(name, mode):
    return action("conditional", GroupingIdentifier=action_id(f"if/{name}"), WFControlFlowMode=mode)


def if_value(name, reference, expected=None):
    opening = branch(name, 0)
    parameters = opening["WFWorkflowActionParameters"]
    parameters["WFInput"] = {"Type": "Variable", "Variable": attachment(reference)}
    parameters["WFCondition"] = 100 if expected is None else 4
    if expected is not None:
        parameters["WFConditionalActionString"] = expected
    return opening


def notification(name, body, reference):
    return action("notification", WFInput=attachment(reference), WFNotificationActionBody=body, UUID=action_id(f"notice/{name}"))


def eligible_categories():
    source = (ROOT / "src/lib/expenseCategories.ts").read_text(encoding="utf-8")
    declared = re.search(r"^export const EXPENSE_CATEGORIES = (\[[^\]]+\]) as const;", source, re.MULTILINE)
    if declared is None:
        raise ValueError("Could not read the supported MoneyTrail expense categories")
    return [category for category in json.loads(re.sub(r",\s*\]$", "]", declared[1])) if category != "待分类"]


def build():
    v4 = runpy.run_path(str(ROOT / "scripts/build-bank-shortcut.py"))
    source, _, updater = v4["V4_SOURCES"][0]
    reviewed, _ = v4["build_v4_bytes"](source, updater)
    workflow, _ = v4["build_sms_v4_bytes"](reviewed)
    baseline = workflow["WFWorkflowActions"]

    prepare = deepcopy(baseline[8])
    prepare_params = prepare["WFWorkflowActionParameters"]
    endpoint = prepare_params["WFURL"].removesuffix("moneytrail_receive_sms")
    prepare_params["WFURL"] = endpoint + "moneytrail_sms_beta_prepare"
    prepare_name = "URL的内容"
    review_token = dictionary_value(prepare, prepare_name, "review_token")
    review = output(review_token, "词典值")
    amount = dictionary_value(prepare, prepare_name, "amount")
    merchant = dictionary_value(prepare, prepare_name, "merchant")

    categories = eligible_categories()
    choices = action("list", WFItems=[*categories, LATER], UUID=action_id("categories"))
    picker = action(
        "choosefromlist", WFInput=attachment(output(choices, "列表")),
        WFChooseFromListActionPrompt=text_token(
            "支出 ¥\ufffc\n商户 \ufffc\n选择一级分类后入账", output(amount, "词典值"), output(merchant, "词典值"),
        ),
        WFChooseFromListActionSelectMultiple=False, UUID=action_id("category"),
    )
    selection = output(picker, "所选项目")
    allowed = "|".join(re.escape(category) for category in categories)
    match = action(
        "text.match", WFMatchTextPattern=rf"\A(?:{allowed})(?![\s\S])", text=text_token("\ufffc", selection),
        WFMatchTextCaseSensitive=True, UUID=action_id("allowed category"),
    )

    json_values = [
        {"WFKey": text_token(key), "WFItemType": 0, "WFValue": text_token("\ufffc", reference)}
        for key, reference in (("p_review_token", review), ("p_category", selection))
    ]
    confirm = action(
        "downloadurl", WFURL=endpoint + "moneytrail_sms_beta_confirm", WFHTTPMethod="POST",
        WFHTTPHeaders=prepare_params["WFHTTPHeaders"], ShowHeaders=True,
        WFJSONValues={"Value": {"WFDictionaryFieldValueItems": json_values}, "WFSerializationType": "WFDictionaryFieldValue"},
        UUID=action_id("confirm"),
    )
    confirmation_status = dictionary_value(confirm, prepare_name, "status")
    status_text = action("gettext", WFTextActionText=text_token("\ufffc", output(confirmation_status, "词典值")),
                         UUID=action_id("confirmation status text"))
    status = output(status_text, "文本")
    pending_body = baseline[16]["WFWorkflowActionParameters"]["WFNotificationActionBody"]
    success_body = baseline[13]["WFWorkflowActionParameters"]["WFNotificationActionBody"]
    unverified_body = "⚠️ 入账结果未确认，请打开账本核对"

    # Keep the reviewed SMS guards and the existing fallback for duplicate or unknown intake results.
    workflow["WFWorkflowActions"] = [
        *baseline[:8], prepare, *baseline[9:12], baseline[15],
        review_token, if_value("review token", review),
        amount, merchant, choices, picker, match, if_value("category chosen", output(match, "匹配的文本")),
        confirm, confirmation_status, status_text, if_value("confirmed", status, "recorded"),
        notification("recorded", success_body, status),
        branch("confirmed", 1), notification("unverified", unverified_body, status), branch("confirmed", 2),
        branch("category chosen", 1), notification("later", pending_body, {"Type": "Variable", "VariableName": "提交状态"}),
        branch("category chosen", 2),
        branch("review token", 1), baseline[16], branch("review token", 2),
        *baseline[17:24], *baseline[25:],
    ]
    declaration, remainder = plistlib.dumps(workflow, sort_keys=False).split(b"\n", 1)
    return declaration + b"\n<!-- UNSIGNED SMS CATEGORY BETA: Apple signing required before installation. -->\n" + remainder


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Check the generated unsigned plist without updating it")
    args = parser.parse_args()
    contents = build()
    if args.check:
        if not OUTPUT.is_file() or OUTPUT.read_bytes() != contents:
            parser.error(f"{OUTPUT.name} differs from its source. Rebuild with {Path(__file__).name}.")
    else:
        OUTPUT.write_bytes(contents)
    print(f"{OUTPUT.name}: {len(plistlib.loads(contents)['WFWorkflowActions'])} native actions")


if __name__ == "__main__":
    main()
