import { useState } from "react";
import { dismissSmsReview, isSmsReviewDue, readSmsReviewState } from "../lib/smsReviewReminder";

export default function SmsReviewReminder({ scope, onOpen }: { scope: string; onOpen: () => void }) {
  const [dismissed, setDismissed] = useState(false);
  const [state] = useState(() => readSmsReviewState(scope));
  if (dismissed || !isSmsReviewDue(state, Date.now())) return null;
  return <aside className="notice warning" role="status" aria-label="每周短信核对提醒">
    <span>距离上次打开短信接收页已超过 7 天。请核对接收记录并与银行账单比对；系统无法发现未触发或未上传的短信。</span>
    <button className="button secondary small" onClick={onOpen}>查看接收核对</button>
    <button className="button ghost small" onClick={() => { dismissSmsReview(scope); setDismissed(true); }}>7 天后提醒</button>
  </aside>;
}
