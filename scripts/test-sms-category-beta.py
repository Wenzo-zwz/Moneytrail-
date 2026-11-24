"""Check the unsigned SMS category beta's native actions and write boundaries."""

from pathlib import Path
import plistlib
import re
import unittest


ROOT = Path(__file__).resolve().parent.parent
SHORTCUTS = ROOT / "public/shortcuts"
PREFIX = "is.workflow.actions."


def rpc_body(parameters):
    return {
        field["WFKey"]["Value"]["string"]: field["WFValue"]["Value"]["attachmentsByRange"]["{0, 1}"]
        for field in parameters["WFJSONValues"]["Value"]["WFDictionaryFieldValueItems"]
    }


def references(token):
    return list(token["Value"].get("attachmentsByRange", {}).values())


def input_reference(parameters):
    value = parameters["WFInput"]
    if value.get("Type") == "Variable":
        value = value["Variable"]
    return value["Value"]


class SmsCategoryBetaTest(unittest.TestCase):
    def setUp(self):
        path = SHORTCUTS / "moneytrail-bank-sms-category-beta.unsigned.plist"
        self.assertTrue(path.is_file(), "The unsigned SMS category beta has not been built")
        self.workflow = plistlib.loads(path.read_bytes())
        self.actions = self.workflow["WFWorkflowActions"]
        self.params = [action["WFWorkflowActionParameters"] for action in self.actions]
        self.kinds = [action["WFWorkflowActionIdentifier"].removeprefix(PREFIX) for action in self.actions]

        self.contexts = []
        branches = []
        for p in self.params:
            self.contexts.append(tuple(branches))
            mode = p.get("WFControlFlowMode")
            if mode == 0:
                branches.append((p, True))
            elif mode in (1, 2):
                start, prior_branch = branches.pop()
                self.assertEqual(start["GroupingIdentifier"], p["GroupingIdentifier"])
                if mode == 1:
                    self.assertTrue(prior_branch)
                    branches.append((start, False))
        self.assertFalse(branches)

    def actions_of(self, kind):
        return [p for k, p in zip(self.kinds, self.params, strict=True) if k == kind]

    def context(self, parameters):
        return self.contexts[self.params.index(parameters)]

    def conditions(self, source):
        return [p for p in self.actions_of("conditional") if p.get("WFControlFlowMode") == 0
                and input_reference(p).get("OutputUUID") == source["UUID"]]

    def fields(self, post):
        return [p for p in self.actions_of("getvalueforkey") if input_reference(p)["OutputUUID"] == post["UUID"]]

    def matches_using(self, *sources):
        return [p for p in self.actions_of("text.match")
                if [ref.get("OutputUUID") for ref in references(p["text"])] == [p["UUID"] for p in sources]]

    def test_preserves_v4_local_filters_and_blank_personal_import_question(self):
        v4 = plistlib.loads((SHORTCUTS / "moneytrail-bank-sms-v4.unsigned.plist").read_bytes())
        self.assertEqual(self.actions[:8], v4["WFWorkflowActions"][:8])
        self.assertEqual(self.workflow["WFWorkflowImportQuestions"], v4["WFWorkflowImportQuestions"])
        self.assertEqual(self.params[0]["WFTextActionText"], "")
        self.assertTrue(self.workflow["WFWorkflowHasShortcutInputVariables"])
        self.assertFalse(any("documentpicker" in action or "openurl" in action for action in self.kinds))

    def test_posts_sms_before_both_pickers_and_auto_recorded_only_notifies(self):
        prepare, confirm = self.actions_of("downloadurl")
        pickers = self.actions_of("choosefromlist")
        self.assertEqual(self.params.index(prepare), 8)
        for picker in pickers:
            self.assertLess(self.params.index(prepare), self.params.index(picker))
            self.assertLess(self.params.index(picker), self.params.index(confirm))
        for post, rpc in zip((prepare, confirm), ("moneytrail_sms_beta_prepare_v2", "moneytrail_sms_beta_confirm_v2"), strict=True):
            self.assertEqual(post["WFHTTPMethod"], "POST")
            self.assertEqual(post["WFURL"], f"https://ojcgabicpjipwpvwolzn.supabase.co/rest/v1/rpc/{rpc}")
        self.assertEqual(rpc_body(prepare), {
            "p_token": {"Type": "Variable", "VariableName": "接入令牌"},
            "p_message": {"Type": "Variable", "VariableName": "短信正文"},
        })

        [recorded] = [p for p in self.actions_of("conditional") if p.get("WFConditionalActionString") == "recorded"
                      and input_reference(p).get("VariableName") == "提交状态"]
        [notification] = [p for p in self.actions_of("notification")
                          if (recorded, True) in self.context(p)]
        body = notification["WFNotificationActionBody"]
        self.assertEqual(body["Value"]["string"], "✅ 已自动记账 ¥\ufffc · \ufffc · \ufffc")
        keys = {p["UUID"]: p["WFDictionaryKey"] for p in self.fields(prepare)}
        self.assertEqual([keys[ref["OutputUUID"]] for ref in references(body)], ["amount", "category", "subcategory"])
        for interactive in (*pickers, confirm):
            self.assertIn((recorded, False), self.context(interactive))

    def test_only_pending_review_with_a_valid_token_and_depth_prompts(self):
        prepare, confirm = self.actions_of("downloadurl")
        primary, secondary = self.actions_of("choosefromlist")
        fields = {p["WFDictionaryKey"]: p for p in self.fields(prepare)}
        [review_match] = self.matches_using(fields["review_token"])
        valid_review = "mt_sms_review_" + "af09" * 16
        self.assertIsNotNone(re.fullmatch(review_match["WFMatchTextPattern"], valid_review))
        for invalid_review in ("", " ", "mt_sms_" + "a" * 64, valid_review[:-1], valid_review + "\n", valid_review.upper()):
            self.assertIsNone(re.fullmatch(review_match["WFMatchTextPattern"], invalid_review))
        [depth_text] = [p for p in self.actions_of("gettext") if isinstance(p["WFTextActionText"], dict)
                        and [r.get("OutputUUID") for r in references(p["WFTextActionText"])] == [fields["category_depth"]["UUID"]]]
        [depth_match] = self.matches_using(depth_text)
        for valid in ("primary", "secondary"):
            self.assertIsNotNone(re.fullmatch(depth_match["WFMatchTextPattern"], valid))
        for invalid in ("", "other", "Secondary", "secondary\n"):
            self.assertIsNone(re.fullmatch(depth_match["WFMatchTextPattern"], invalid))

        [pending] = [p for p in self.actions_of("conditional") if p.get("WFConditionalActionString") == "pending"]
        [has_review] = self.conditions(review_match)
        [has_depth] = self.conditions(depth_match)
        self.assertEqual(pending["WFCondition"], 4)
        self.assertEqual(has_review["WFCondition"], 100)
        self.assertEqual(has_depth["WFCondition"], 100)
        for interactive in (primary, secondary, confirm):
            self.assertTrue(all((guard, True) in self.context(interactive) for guard in (pending, has_review, has_depth)))
        self.assertEqual(rpc_body(confirm)["p_review_token"]["OutputUUID"], review_match["UUID"])

        [secondary_depth] = self.conditions(depth_text)
        self.assertEqual(secondary_depth["WFConditionalActionString"], "secondary")
        self.assertIn((secondary_depth, True), self.context(secondary))
        self.assertNotIn((secondary_depth, True), self.context(primary))
        self.assertNotIn((secondary_depth, True), self.context(confirm))

    def test_pickers_offer_only_valid_categories_and_no_deferral_can_confirm(self):
        _, confirm = self.actions_of("downloadurl")
        primary, secondary = self.actions_of("choosefromlist")
        [primary_choices] = self.actions_of("list")
        primary_items = primary_choices["WFItems"]
        self.assertEqual(primary_items, [
            "食品酒水", "居住与家用", "交通出行", "衣着与美妆", "休闲娱乐", "医疗保健",
            "学习培训", "人情往来", "通讯", "其他", "稍后处理",
        ])
        self.assertEqual(input_reference(primary)["OutputUUID"], primary_choices["UUID"])
        [primary_match] = self.matches_using(primary)
        [has_primary] = self.conditions(primary_match)
        self.assertEqual(has_primary["WFCondition"], 100)
        for category in primary_items[:-1]:
            self.assertIsNotNone(re.fullmatch(primary_match["WFMatchTextPattern"], category))
        for deferred in ("", "稍后处理", "待分类", "食品酒水\n其他"):
            self.assertIsNone(re.fullmatch(primary_match["WFMatchTextPattern"], deferred))

        [secondary_choices] = self.actions_of("dictionary")
        choices_by_category = {}
        for field in secondary_choices["WFItems"]["Value"]["WFDictionaryFieldValueItems"]:
            self.assertEqual(field["WFItemType"], 2)
            self.assertEqual(field["WFValue"]["WFSerializationType"], "WFArrayParameterState")
            choices_by_category[field["WFKey"]["Value"]["string"]] = field["WFValue"]["Value"]
        self.assertEqual(list(choices_by_category), primary_items[:-1])
        self.assertIn("咖啡奶茶", choices_by_category["食品酒水"])
        self.assertIn("公共交通", choices_by_category["交通出行"])
        self.assertIn("家庭宽带", choices_by_category["通讯"])
        [secondary_options] = self.fields(secondary_choices)
        self.assertEqual(references(secondary_options["WFDictionaryKey"])[0]["OutputUUID"], primary_match["UUID"])
        self.assertEqual(input_reference(secondary)["OutputUUID"], secondary_options["UUID"])
        self.assertFalse(primary["WFChooseFromListActionSelectMultiple"])
        self.assertFalse(secondary["WFChooseFromListActionSelectMultiple"])

        [map_primary_only] = self.actions_of("text.replace")
        self.assertEqual(references(map_primary_only["WFInput"])[0]["OutputUUID"], secondary["UUID"])
        self.assertTrue(map_primary_only["WFReplaceTextRegularExpression"])
        self.assertEqual(map_primary_only["WFReplaceTextReplace"], "未细分")
        pattern = map_primary_only["WFReplaceTextFind"]
        self.assertIsNotNone(re.fullmatch(pattern, "只记一级"))
        for invalid in ("", "未细分", "稍后处理", "只记一级\n"):
            self.assertIsNone(re.fullmatch(pattern, invalid))

        body = rpc_body(confirm)
        self.assertEqual(set(body), {"p_review_token", "p_category", "p_subcategory"})
        self.assertEqual(body["p_category"]["OutputUUID"], primary_match["UUID"])
        from_secondary, from_primary = [p for p in self.actions_of("setvariable")
                                        if p["WFVariableName"] == body["p_subcategory"]["VariableName"]]
        [secondary_branch] = [p for p in self.actions_of("conditional") if p.get("WFConditionalActionString") == "secondary"]
        self.assertIn((secondary_branch, True), self.context(from_secondary))
        self.assertIn((secondary_branch, False), self.context(from_primary))
        self.assertEqual(input_reference(from_secondary)["OutputUUID"], map_primary_only["UUID"])
        [unspecified] = [p for p in self.actions_of("gettext") if p.get("UUID") == input_reference(from_primary)["OutputUUID"]]
        self.assertEqual(unspecified["WFTextActionText"]["Value"]["string"], "未细分")
        [valid_pair] = [p for p in self.actions_of("text.match") if references(p["text"]) == [body["p_category"], body["p_subcategory"]]]
        for category, options in choices_by_category.items():
            self.assertEqual(options[-2:], ["只记一级", "稍后处理"])
            for detail in (*options[:-2], "未细分"):
                self.assertIsNotNone(re.fullmatch(valid_pair["WFMatchTextPattern"], f"{category}/{detail}"))
            for deferred in ("", "稍后处理", "只记一级", "未细分\n"):
                self.assertIsNone(re.fullmatch(valid_pair["WFMatchTextPattern"], f"{category}/{deferred}"))
        self.assertIsNone(re.fullmatch(valid_pair["WFMatchTextPattern"], "交通出行/咖啡奶茶"))
        self.assertIsNone(re.fullmatch(valid_pair["WFMatchTextPattern"], "待分类/未细分"))
        [has_pair] = self.conditions(valid_pair)
        self.assertEqual(has_pair["WFCondition"], 100)
        for guard in (has_primary, has_pair):
            self.assertIn((guard, True), self.context(confirm))
            deferred = [p for p in self.actions_of("notification") if (guard, False) in self.context(p)]
            self.assertTrue(any("待确认" in p["WFNotificationActionBody"] for p in deferred))

    def test_saved_merchant_recommendation_only_decorates_the_prompt(self):
        prepare, confirm = self.actions_of("downloadurl")
        primary, _ = self.actions_of("choosefromlist")
        fields = {p["WFDictionaryKey"]: p for p in self.fields(prepare)}
        [suggested_primary] = self.matches_using(fields["suggested_category"])
        [primary_guard] = self.conditions(suggested_primary)
        [suggested_pair] = [p for p in self.actions_of("text.match")
                            if [r.get("OutputUUID") for r in references(p["text"])][:2] ==
                            [fields["suggested_category"]["UUID"], fields["suggested_subcategory"]["UUID"]]]
        [secondary_guard] = self.conditions(suggested_pair)
        self.assertIsNotNone(re.fullmatch(suggested_pair["WFMatchTextPattern"], "食品酒水/咖啡奶茶/secondary"))
        for invalid in ("食品酒水/咖啡奶茶/primary", "交通出行/咖啡奶茶/secondary", "食品酒水/稍后处理/secondary"):
            self.assertIsNone(re.fullmatch(suggested_pair["WFMatchTextPattern"], invalid))
        prompt = primary["WFChooseFromListActionPrompt"]
        suggestion = references(prompt)[-1]
        self.assertEqual(suggestion["Type"], "Variable")
        blank, primary_suggestion, secondary_suggestion = [
            p for p in self.actions_of("setvariable") if p["WFVariableName"] == suggestion["VariableName"]
        ]
        self.assertNotIn((primary_guard, True), self.context(blank))
        self.assertIn((primary_guard, True), self.context(primary_suggestion))
        self.assertIn((secondary_guard, True), self.context(secondary_suggestion))
        self.assertNotIn(suggestion, rpc_body(confirm).values())


if __name__ == "__main__":
    unittest.main()
