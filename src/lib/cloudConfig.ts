export type CloudConfig = { url: string; publishableKey: string };

function safeProjectUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.search || url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) return null;
    return url.origin;
  } catch { return null; }
}

function isPublicKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const key = value.trim();
  if (!key || key.startsWith("sb_secret_")) return false;
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return true;
  const parts = key.split(".");
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
  try {
    const payload = parts[1].replaceAll("-", "+").replaceAll("_", "/");
    const json = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")));
    // Only the legacy anonymous frontend key belongs in a public website build.
    return json && typeof json === "object" && json.role === "anon";
  } catch { return false; }
}

/** Public build configuration only; an administrator key is never accepted. */
function configuredPublicKey(env: Record<string, unknown>): unknown {
  const primary = env.VITE_SUPABASE_PUBLISHABLE_KEY;
  // An empty example value must not hide a configured legacy frontend key.
  return primary == null || (typeof primary === "string" && !primary.trim())
    ? env.VITE_SUPABASE_ANON_KEY
    : primary;
}

export function readCloudConfig(env: Record<string, unknown>): CloudConfig | null {
  const url = safeProjectUrl(env.VITE_SUPABASE_URL);
  const configuredKey = configuredPublicKey(env);
  if (!url || !isPublicKey(configuredKey)) return null;
  return { url, publishableKey: configuredKey.trim() };
}

export function getCloudConfigError(env: Record<string, unknown>): string | null {
  if (readCloudConfig(env)) return null;
  const hasUrl = typeof env.VITE_SUPABASE_URL === "string" && Boolean(env.VITE_SUPABASE_URL.trim());
  const key = configuredPublicKey(env);
  if (!hasUrl && (typeof key !== "string" || !key.trim())) return "账号服务尚未配置。";
  if (!safeProjectUrl(env.VITE_SUPABASE_URL)) return "账号服务地址配置不正确，请联系应用维护者。";
  return "账号服务公开密钥配置不正确，请勿使用管理员或 Secret key。";
}

