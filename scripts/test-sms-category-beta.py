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


class SmsCategoryBetaTest(unittest.TestCase):
    def setUp(self):
        path = SHORTCUTS / "moneytrail-bank-sms-category-beta.unsigned.plist"
        self.assertTrue(path.is_file(), "The unsigned SMS category beta has not been built")
        self.workflow = plistlib.loads(path.read_bytes())
        self.actions = self.workflow["WFWorkflowActions"]
        self.params = [action["WFWorkflowActionParameters"] for action in self.actions]
        self.kinds = [action["WFWorkflowActionIdentifier"].removeprefix(PREFIX) for action in self.actions]

    def test_preserves_v4_local_filters_and_blank_personal_import_question(self):
        v4 = plistlib.loads((SHORTCUTS / "moneytrail-bank-sms-v4.unsigned.plist").read_bytes())
        self.assertEqual(self.actions[:8], v4["WFWorkflowActions"][:8])
        self.assertEqual(self.workflow["WFWorkflowImportQuestions"], v4["WFWorkflowImportQuestions"])
        self.assertEqual(self.params[0]["WFTextActionText"], "")
        self.assertTrue(self.workflow["WFWorkflowHasShortcutInputVariables"])
        self.assertFalse(any("documentpicker" in action or "openurl" in action for action in self.kinds))

    def test_posts_sms_before_prompt_and_confirms_only_an_explicit_category(self):
        posts = [i for i, kind in enumerate(self.kinds) if kind == "downloadurl"]
        prepare, confirm = posts
        picker = self.kinds.index("choosefromlist")
        choices = self.kinds.index("list")
        self.assertEqual(prepare, 8)
        self.assertLess(prepare, picker)
        self.assertLess(picker, confirm)
        for index, rpc in zip(posts, ("moneytrail_sms_beta_prepare", "moneytrail_sms_beta_confirm"), strict=True):
            self.assertEqual(self.params[index]["WFHTTPMethod"], "POST")
            self.assertEqual(self.params[index]["WFURL"], f"https://ojcgabicpjipwpvwolzn.supabase.co/rest/v1/rpc/{rpc}")
        self.assertEqual(rpc_body(self.params[prepare]), {
            "p_token": {"Type": "Variable", "VariableName": "接入令牌"},
            "p_message": {"Type": "Variable", "VariableName": "短信正文"},
        })

        params = self.params[picker]
        self.assertFalse(params["WFChooseFromListActionSelectMultiple"])
        self.assertEqual(params["WFInput"]["Value"]["OutputUUID"], self.params[choices]["UUID"])
        offered = self.params[choices]["WFItems"]
        self.assertEqual(offered, ["食品酒水", "居住与家用", "交通出行", "衣着与美妆", "休闲娱乐", "医疗保健",
                                   "学习培训", "人情往来", "通讯", "其他", "稍后处理"])
        fields = {p["WFDictionaryKey"]: p for p in self.params if p.get("WFDictionaryKey") in ("amount", "merchant", "review_token")}
        for value in fields.values():
            self.assertEqual(value["WFInput"]["Value"]["OutputUUID"], self.params[prepare]["UUID"])
        prompt = params["WFChooseFromListActionPrompt"]["Value"]
        self.assertEqual(prompt["string"], "支出 ¥\ufffc\n商户 \ufffc\n选择一级分类后入账")
        self.assertEqual({span: v["OutputUUID"] for span, v in prompt["attachmentsByRange"].items()},
                         {"{4, 1}": fields["amount"]["UUID"], "{9, 1}": fields["merchant"]["UUID"]})

        [match] = [p for p in self.params[picker + 1:confirm] if "WFMatchTextPattern" in p]
        self.assertEqual(match["text"]["Value"]["attachmentsByRange"]["{0, 1}"]["OutputUUID"], params["UUID"])
        for category in offered[:-1]:
            self.assertIsNotNone(re.fullmatch(match["WFMatchTextPattern"], category))
        for deferred in ("", "稍后处理", "待分类", "食品酒水\n其他"):
            self.assertIsNone(re.fullmatch(match["WFMatchTextPattern"], deferred))

        body = rpc_body(self.params[confirm])
        self.assertEqual(set(body), {"p_review_token", "p_category"})
        self.assertEqual(body["p_review_token"]["OutputUUID"], fields["review_token"]["UUID"])
        self.assertEqual(body["p_category"]["OutputUUID"], params["UUID"])

        branches = []
        for i, p in enumerate(self.params):
            mode = p.get("WFControlFlowMode")
            if i in (picker, confirm):
                conditions = [b for b, mode in branches if mode == 0]
                self.assertTrue(any(b.get("WFConditionalActionString") == "pending" and b["WFCondition"] == 4 for b in conditions))
                has_value_inputs = [b["WFInput"]["Variable"]["Value"].get("OutputUUID") for b in conditions if b["WFCondition"] == 100]
                self.assertIn(fields["review_token"]["UUID"], has_value_inputs)
                if i == confirm:
                    self.assertIn(match["UUID"], has_value_inputs)
            if mode == 0:
                branches.append((p, mode))
            elif mode in (1, 2):
                start, previous = branches.pop()
                self.assertEqual(start["GroupingIdentifier"], p["GroupingIdentifier"])
                if mode == 1:
                    self.assertEqual(previous, 0)
                    branches.append((start, mode))
        self.assertEqual(branches, [])


if __name__ == "__main__":
    unittest.main()
