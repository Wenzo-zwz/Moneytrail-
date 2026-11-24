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
PRIMARY_ONLY = "只记一级"
UNSPECIFIED = "未细分"
SUBCATEGORY = {"Type": "Variable", "VariableName": "待提交二级分类"}
SUBMISSION_STATUS = {"Type": "Variable", "VariableName": "提交状态"}


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


def dictionary_value(source, key, name=None):
    return action("getvalueforkey", WFInput=attachment(source), WFDictionaryKey=key, UUID=action_id(f"field/{name or key}"))


def dictionary_fields(fields):
    return {"Value": {"WFDictionaryFieldValueItems": fields}, "WFSerializationType": "WFDictionaryFieldValue"}


def text_field(key, value):
    return {"WFKey": text_token(key), "WFItemType": 0, "WFValue": value}


def text_action(name, template, *references):
    return action("gettext", WFTextActionText=text_token(template, *references), UUID=action_id(name))


def set_variable(name, reference):
    return action("setvariable", WFVariableName=name, WFInput=attachment(reference))


def exact(pattern):
    return rf"\A(?:{pattern})(?![\s\S])"


def alternatives(items):
    return "|".join(re.escape(item) for item in items)


def match_text(name, pattern, template, *references):
    return action(
        "text.match", WFMatchTextPattern=exact(pattern), text=text_token(template, *references),
        WFMatchTextCaseSensitive=True, UUID=action_id(name),
    )


def picker(name, source, prompt):
    return action(
        "choosefromlist", WFInput=attachment(source), WFChooseFromListActionPrompt=prompt,
        WFChooseFromListActionSelectMultiple=False, UUID=action_id(name),
    )


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


def expense_taxonomy():
    source = (ROOT / "src/lib/expenseCategories.ts").read_text(encoding="utf-8")
    declared = re.search(r"^export const EXPENSE_CATEGORIES = (\[[^\]]+\]) as const;", source, re.MULTILINE)
    details = re.search(r"^export const EXPENSE_DETAILS:[^\n]+ = \{\n([^}]+)\};", source, re.MULTILINE)
    if declared is None or details is None:
        raise ValueError("Could not read the MoneyTrail expense taxonomy")
    categories = json.loads(re.sub(r",\s*\]$", "]", declared[1]))
    details_by_category = {}
    for line in details[1].splitlines():
        entry = re.fullmatch(r'\s+(\w+|"[^"]+"): (\[[^\]]*\]),', line)
        if entry is None:
            raise ValueError(f"Could not read MoneyTrail expense details: {line}")
        details_by_category[entry[1].strip('"')] = json.loads(entry[2])
    if set(details_by_category) - set(categories):
        raise ValueError("Expense details include an unknown MoneyTrail category")
    return {category: details_by_category.get(category, []) for category in categories if category != "待分类"}


def category_detail_pattern(taxonomy, extra=()):
    return "|".join(
        rf"{re.escape(category)}/(?:{alternatives([*details, *extra])})"
        for category, details in taxonomy.items() if details or extra
    )


def recommendation_actions(taxonomy, suggested_category, suggested_subcategory, depth):
    name = "分类建议"
    blank = text_action("no recommendation", "")
    category_match = match_text("allowed recommended category", alternatives(taxonomy), "\ufffc", suggested_category)
    detail_match = match_text(
        "allowed recommended detail", rf"(?:{category_detail_pattern(taxonomy)})/secondary",
        "\ufffc/\ufffc/\ufffc", suggested_category, suggested_subcategory, depth,
    )
    primary = text_action("recommend primary", "\n建议分类：\ufffc", suggested_category)
    secondary = text_action("recommend secondary", "\n建议分类：\ufffc · \ufffc", suggested_category, suggested_subcategory)
    return [
        blank, set_variable(name, output(blank, "文本")),
        category_match, if_value("recommended category", output(category_match, "匹配的文本")),
        primary, set_variable(name, output(primary, "文本")),
        detail_match, if_value("recommended detail", output(detail_match, "匹配的文本")),
        secondary, set_variable(name, output(secondary, "文本")),
        branch("recommended detail", 2), branch("recommended category", 2),
    ]


def build():
    v4 = runpy.run_path(str(ROOT / "scripts/build-bank-shortcut.py"))
    source, _, updater = v4["V4_SOURCES"][0]
    reviewed, _ = v4["build_v4_bytes"](source, updater)
    workflow, _ = v4["build_sms_v4_bytes"](reviewed)
    baseline = workflow["WFWorkflowActions"]

    prepare = deepcopy(baseline[8])
    prepare_params = prepare["WFWorkflowActionParameters"]
    endpoint = prepare_params["WFURL"].removesuffix("moneytrail_receive_sms")
    prepare_params["WFURL"] = endpoint + "moneytrail_sms_beta_prepare_v2"
    prepared = output(prepare, "URL的内容")
    review_token = dictionary_value(prepared, "review_token")
    # Shortcuts can treat a present dictionary key with an empty value as having a value.
    review_match = match_text("eligible review token", r"mt_sms_review_[a-f0-9]{64}", "\ufffc", output(review_token, "词典值"))
    review = output(review_match, "匹配的文本")
    category_depth = dictionary_value(prepared, "category_depth")
    depth_text = text_action("category depth text", "\ufffc", output(category_depth, "词典值"))
    depth = output(depth_text, "文本")
    depth_match = match_text("allowed category depth", "primary|secondary", "\ufffc", depth)
    amount = dictionary_value(prepared, "amount")
    amount_value = output(amount, "词典值")
    merchant = dictionary_value(prepared, "merchant")
    merchant_value = output(merchant, "词典值")
    saved_category = dictionary_value(prepared, "suggested_category")
    saved_subcategory = dictionary_value(prepared, "suggested_subcategory")

    taxonomy = expense_taxonomy()
    choices = action("list", WFItems=[*taxonomy, LATER], UUID=action_id("categories"))
    choose_category = picker(
        "category", output(choices, "列表"),
        text_token(
            "支出 ¥\ufffc\n商户 \ufffc\ufffc\n选择一级分类",
            amount_value, merchant_value, {"Type": "Variable", "VariableName": "分类建议"},
        ),
    )
    category_match = match_text("allowed category", alternatives(taxonomy), "\ufffc", output(choose_category, "所选项目"))
    category = output(category_match, "匹配的文本")
    detail_choices = action(
        "dictionary",
        WFItems=dictionary_fields([
            {
                "WFKey": text_token(label), "WFItemType": 2,
                "WFValue": {"WFSerializationType": "WFArrayParameterState", "Value": [*details, PRIMARY_ONLY, LATER]},
            }
            for label, details in taxonomy.items()
        ]),
        UUID=action_id("detail choices"),
    )
    selected_choices = dictionary_value(output(detail_choices, "词典"), text_token("\ufffc", category), "selected detail choices")
    choose_detail = picker(
        "detail", output(selected_choices, "词典值"),
        text_token("支出 ¥\ufffc\n商户 \ufffc\n\ufffc · 选择二级分类", amount_value, merchant_value, category),
    )
    mapped_detail = action(
        "text.replace", WFInput=text_token("\ufffc", output(choose_detail, "所选项目")),
        WFReplaceTextFind=exact(re.escape(PRIMARY_ONLY)), WFReplaceTextReplace=UNSPECIFIED,
        WFReplaceTextCaseSensitive=True, WFReplaceTextRegularExpression=True,
        UUID=action_id("map only primary to unspecified"),
    )
    unspecified = text_action("use primary only", UNSPECIFIED)
    pair_match = match_text(
        "allowed category detail pair", category_detail_pattern(taxonomy, (UNSPECIFIED,)),
        "\ufffc/\ufffc", category, SUBCATEGORY,
    )

    json_values = [
        text_field(key, text_token("\ufffc", reference))
        for key, reference in (("p_review_token", review), ("p_category", category), ("p_subcategory", SUBCATEGORY))
    ]
    confirm = action(
        "downloadurl", WFURL=endpoint + "moneytrail_sms_beta_confirm_v2", WFHTTPMethod="POST",
        WFHTTPHeaders=prepare_params["WFHTTPHeaders"], ShowHeaders=True,
        WFJSONValues=dictionary_fields(json_values),
        UUID=action_id("confirm"),
    )
    confirmation_status = dictionary_value(output(confirm, "URL的内容"), "status")
    status_text = text_action("confirmation status text", "\ufffc", output(confirmation_status, "词典值"))
    status = output(status_text, "文本")
    pending_body = baseline[16]["WFWorkflowActionParameters"]["WFNotificationActionBody"]
    success_body = baseline[13]["WFWorkflowActionParameters"]["WFNotificationActionBody"]
    unverified_body = "⚠️ 入账结果未确认，请打开账本核对"
    recorded_amount = dictionary_value(prepared, "amount", "recorded amount")
    recorded_category = dictionary_value(prepared, "category")
    recorded_subcategory = dictionary_value(prepared, "subcategory")
    automatic_body = text_token(
        "✅ 已自动记账 ¥\ufffc · \ufffc · \ufffc",
        output(recorded_amount, "词典值"), output(recorded_category, "词典值"), output(recorded_subcategory, "词典值"),
    )

    # Keep the reviewed SMS guards and the existing fallback for duplicate or unknown intake results.
    workflow["WFWorkflowActions"] = [
        *baseline[:8], prepare, *baseline[9:13],
        recorded_amount, recorded_category, recorded_subcategory, notification("automatic", automatic_body, SUBMISSION_STATUS),
        *baseline[14:16],
        review_token, review_match, category_depth, depth_text, depth_match,
        if_value("review token", review), if_value("category depth", output(depth_match, "匹配的文本")),
        amount, merchant, saved_category, saved_subcategory,
        *recommendation_actions(taxonomy, output(saved_category, "词典值"), output(saved_subcategory, "词典值"), depth),
        choices, choose_category, category_match, if_value("category chosen", category),
        if_value("second level", depth, "secondary"),
        detail_choices, selected_choices, choose_detail, mapped_detail,
        set_variable(SUBCATEGORY["VariableName"], output(mapped_detail, "更新的文本")),
        branch("second level", 1), unspecified,
        set_variable(SUBCATEGORY["VariableName"], output(unspecified, "文本")), branch("second level", 2),
        pair_match, if_value("allowed pair", output(pair_match, "匹配的文本")),
        confirm, confirmation_status, status_text, if_value("confirmed", status, "recorded"),
        notification("recorded", success_body, status),
        branch("confirmed", 1), notification("unverified", unverified_body, status), branch("confirmed", 2),
        branch("allowed pair", 1), notification("detail later", pending_body, SUBMISSION_STATUS),
        branch("allowed pair", 2),
        branch("category chosen", 1), notification("category later", pending_body, SUBMISSION_STATUS),
        branch("category chosen", 2),
        branch("category depth", 1), notification("unknown category depth", pending_body, SUBMISSION_STATUS),
        branch("category depth", 2),
        branch("review token", 1), baseline[16], branch("review token", 2),
        *baseline[17:],
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
