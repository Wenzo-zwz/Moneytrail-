import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ArrowLeft, ArrowRight, Check, Eye, EyeOff, LockKeyhole, Mail, RefreshCw, ShieldCheck, UserRound } from "lucide-react";

type AuthMode = "login" | "register" | "forgot" | "recovery";

export interface AuthFormProps {
  client: SupabaseClient;
  initialMode?: AuthMode;
  onRecoveryComplete?: () => void;
  configurationError?: string;
  legacyPresent?: boolean;
}

function friendlyError(error: unknown, mode: AuthMode): string {
  const value = error as { code?: string; name?: string; status?: number } | null;
  const code = value?.code ?? "";
  if (code === "invalid_credentials") return "邮箱或密码不正确，请检查后重试。";
  if (code === "email_not_confirmed") return "请先在邮箱中完成验证，再回来登录。";
  if (code === "signup_disabled") return "当前暂未开放新账号注册，请稍后再试。";
  if (code === "same_password") return "新密码与当前密码相同，请设置其他密码。";
  if (code === "weak_password" || code === "validation_failed") return "请检查邮箱格式，并使用至少 12 位的密码。";
  if (code === "user_already_exists" || code === "email_exists") return "请检查邮箱中的验证邮件；已有账号可以直接登录或找回密码。";
  if (code.includes("rate_limit") || value?.status === 429) return "操作过于频繁，请稍等片刻后再试。";
  if (value?.name === "AuthRetryableFetchError" || value?.name === "TypeError") return "暂时无法连接账号服务，请检查网络后重试。";
  if (value?.status && value.status >= 500) return "账号服务暂时不可用，请稍后重试。";
  if (mode === "login") return "登录未完成，请检查邮箱和密码后重试。";
  if (mode === "forgot") return "重置邮件暂未发送，请稍后重试。";
  if (mode === "recovery") return "密码更新未完成，验证链接可能已经失效，请重新申请。";
  return "注册暂未完成，请稍后重试。";
}

export default function AuthForm({
  client,
  initialMode = "login",
  onRecoveryComplete,
  configurationError,
  legacyPresent = false,
}: AuthFormProps) {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [recoveryDone, setRecoveryDone] = useState(false);
  const mounted = useRef(false);
  const requestNumber = useRef(0);
  const submitting = useRef(false);
  const id = useId();
  const emailId = `${id}-email`;
  const passwordId = `${id}-password`;
  const confirmationId = `${id}-confirmation`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestNumber.current += 1;
      submitting.current = false;
    };
  }, []);

  useEffect(() => {
    requestNumber.current += 1;
    submitting.current = false;
    setMode(initialMode);
    setBusy(false);
    setPassword("");
    setConfirmation("");
    setShowPassword(false);
    setError("");
    setSuccess("");
    setRecoveryDone(false);
  }, [initialMode]);

  function switchMode(next: AuthMode) {
    if (submitting.current) return;
    requestNumber.current += 1;
    setMode(next);
    setPassword("");
    setConfirmation("");
    setShowPassword(false);
    setError("");
    setSuccess("");
    setRecoveryDone(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || configurationError || recoveryDone) return;
    const isNewPassword = mode === "register" || mode === "recovery";
    if (isNewPassword && (password.length < 12 || password.length > 128)) {
      setError("请设置 12–128 位密码。建议混合字母、数字和符号。");
      return;
    }
    if (isNewPassword && password !== confirmation) {
      setError("两次输入的密码不一致，请重新确认。");
      return;
    }
    const request = ++requestNumber.current;
    const isCurrent = () => mounted.current && request === requestNumber.current;
    submitting.current = true;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const address = email.trim().toLowerCase();
      const redirectTo = new URL(import.meta.env.BASE_URL, location.origin).href;
      if (mode === "login") {
        const { error: authError } = await client.auth.signInWithPassword({ email: address, password });
        if (authError) throw authError;
        if (isCurrent()) setSuccess("登录成功，正在打开你的账本。");
      } else if (mode === "register") {
        const { data, error: authError } = await client.auth.signUp({
          email: address,
          password,
          options: { emailRedirectTo: redirectTo },
        });
        if (authError) throw authError;
        if (isCurrent()) {
          setSuccess(data.session ? "账号已建立，正在打开你的账本。" : "注册请求已提交。请检查邮箱并完成验证，再回来登录；已有账号也可以直接登录或找回密码。");
        }
      } else if (mode === "forgot") {
        const { error: authError } = await client.auth.resetPasswordForEmail(address, { redirectTo });
        if (authError) throw authError;
        if (isCurrent()) setSuccess("如果此邮箱可以接收重置邮件，你将收到验证链接。请从邮件打开链接后设置新密码。");
      } else {
        const { error: authError } = await client.auth.updateUser({ password });
        if (authError) throw authError;
        if (isCurrent()) {
          setRecoveryDone(true);
          setSuccess("密码已更新，可以继续使用你的账本。");
        }
      }
      if (isCurrent()) {
        setPassword("");
        setConfirmation("");
      }
    } catch (authError) {
      if (isCurrent()) setError(friendlyError(authError, mode));
    } finally {
      if (isCurrent()) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }

  const title = mode === "register" ? "建立你的独立账本" : mode === "forgot" ? "找回你的账号" : mode === "recovery" ? "设置新的登录密码" : "回到你的消费轨迹";
  const subtitle = mode === "register" ? "用邮箱建立账号，在不同设备之间接续记录。" : mode === "forgot" ? "我们会向你的邮箱发送密码重置链接。" : mode === "recovery" ? "请设置一个与你的其他账号不同的密码。" : "登录后查看当前账户的账目与预算。";
  const buttonLabel = mode === "register" ? "创建账号" : mode === "forgot" ? "发送重置邮件" : mode === "recovery" ? "更新密码" : "登录我的账本";
  const passwordVisible = mode !== "forgot" && !recoveryDone;
  const newPassword = mode === "register" || mode === "recovery";
  const disabled = busy || Boolean(configurationError);

  return <main className="auth-shell">
    <section className="auth-story" aria-label="Moneytrail 独立账号账本">
      <div className="auth-brand"><div className="brand-mark"><svg viewBox="120 140 272 240" width="25" height="25" fill="none" aria-hidden="true"><path d="M150 334V178l106 114 106-114v156" stroke="currentColor" strokeWidth="27" strokeLinejoin="round" strokeLinecap="round" /></svg></div><div><strong>Moneytrail</strong><span>个人消费账本</span></div></div>
      <div className="auth-story-copy"><p className="auth-eyebrow">ONE ACCOUNT. YOUR LEDGER.</p><h1>你的账户。<br />你的消费轨迹。</h1><p>让每一笔记录有自己的归属，<br />让生活的花销慢慢清晰。</p></div>
      <div className="auth-material-card" aria-hidden="true"><div className="auth-card-rim" /><span>MONEYTRAIL</span><svg viewBox="120 140 272 240" fill="none"><path d="M150 334V178l106 114 106-114v156" stroke="currentColor" strokeWidth="16" strokeLinejoin="round" strokeLinecap="round" /></svg><div className="auth-card-foot"><span>PERSONAL LEDGER</span><LockKeyhole size={17} /></div></div>
      <div className="auth-feature-list"><div><UserRound size={17} /><span>每个账户，独立记录</span></div><div><RefreshCw size={17} /><span>在不同设备继续记账</span></div><div><ShieldCheck size={17} /><span>本机账目经你确认后迁移</span></div></div>
      <p className="auth-story-footer">MONEYTRAIL / KEEP YOUR MONEY IN VIEW</p>
    </section>
    <section className="auth-form-side" aria-labelledby={`${id}-title`}>
      <div className="auth-form-card">
        {mode === "forgot" && <button type="button" className="auth-back" disabled={busy} onClick={() => switchMode("login")}><ArrowLeft size={16} />返回登录</button>}
        <span className="auth-form-kicker">{mode === "recovery" ? "ACCOUNT RECOVERY" : mode === "forgot" ? "RESET PASSWORD" : "YOUR PERSONAL ACCOUNT"}</span>
        <h2 id={`${id}-title`}>{title}</h2><p className="auth-form-subtitle">{subtitle}</p>
        {(mode === "login" || mode === "register") && <div className="auth-mode-switch" aria-label="账号操作"><button type="button" aria-pressed={mode === "login"} className={mode === "login" ? "active" : ""} disabled={busy} onClick={() => switchMode("login")}>登录</button><button type="button" aria-pressed={mode === "register"} className={mode === "register" ? "active" : ""} disabled={busy} onClick={() => switchMode("register")}>注册账号</button></div>}
        <form onSubmit={submit} className="auth-form" aria-busy={busy}>
          {mode !== "recovery" && <div className="auth-field"><label htmlFor={emailId}>邮箱</label><div className="auth-input-wrap"><Mail size={17} aria-hidden="true" /><input id={emailId} name="username" type="email" autoComplete={mode === "forgot" ? "email" : "username"} required maxLength={254} placeholder="you@example.com" value={email} disabled={disabled} onChange={event => setEmail(event.target.value)} spellCheck={false} autoCapitalize="none" /></div></div>}
          {passwordVisible && <div className="auth-field"><label htmlFor={passwordId}>{mode === "recovery" ? "新密码" : "密码"}</label><div className="auth-input-wrap"><LockKeyhole size={17} aria-hidden="true" /><input id={passwordId} name="password" type={showPassword ? "text" : "password"} autoComplete={newPassword ? "new-password" : "current-password"} minLength={newPassword ? 12 : 1} maxLength={128} aria-describedby={newPassword ? hintId : undefined} required value={password} placeholder={newPassword ? "至少 12 位，最多 128 位" : "输入你的密码"} disabled={disabled} onChange={event => setPassword(event.target.value)} /><button type="button" className="auth-password-toggle" aria-label={showPassword ? "隐藏密码" : "显示密码"} aria-pressed={showPassword} disabled={disabled} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></div>{newPassword && <p id={hintId} className="auth-field-hint">建议混合字母、数字和符号，不使用其他账号的密码。</p>}</div>}
          {newPassword && !recoveryDone && <div className="auth-field"><label htmlFor={confirmationId}>确认密码</label><div className="auth-input-wrap"><LockKeyhole size={17} aria-hidden="true" /><input id={confirmationId} name="password-confirmation" type={showPassword ? "text" : "password"} autoComplete="new-password" minLength={12} maxLength={128} required value={confirmation} placeholder="再次输入新密码" disabled={disabled} onChange={event => setConfirmation(event.target.value)} /></div></div>}
          {mode === "login" && <button type="button" className="auth-forgot" disabled={busy} onClick={() => switchMode("forgot")}>忘记密码？</button>}
          {configurationError && <p className="auth-feedback error" role="alert">{configurationError}</p>}
          {error && <p id={errorId} className="auth-feedback error" role="alert">{error}</p>}
          {success && <p className="auth-feedback success" role="status"><Check size={17} />{success}</p>}
          {recoveryDone ? <button type="button" className="button primary auth-submit" onClick={() => onRecoveryComplete ? onRecoveryComplete() : switchMode("login")}>进入我的账本<ArrowRight size={17} /></button> : <button type="submit" className="button primary auth-submit" disabled={disabled}>{busy ? <><RefreshCw size={17} className="auth-spinning" />正在处理…</> : <>{buttonLabel}<ArrowRight size={17} /></>}</button>}
        </form>
        {legacyPresent && <div className="auth-legacy-note"><ShieldCheck size={18} /><p>原本的本机账目会保留；登录后由你决定是否导入此账户。</p></div>}
        <p className="auth-bottom-note">请在公用设备上使用后退出账号。</p>
      </div>
    </section>
  </main>;
}
