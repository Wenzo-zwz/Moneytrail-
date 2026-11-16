export const MAX_SCREENSHOT_TEXT_LENGTH = 16_000;
const SCREENSHOT_KEY = "screenshot";
const SCREENSHOT_KEYS = new Set([SCREENSHOT_KEY, "alipay-screenshot"]);

export type ScreenshotIntake = Readonly<{ id: number; text: string; error?: string }>;
export type ScreenshotFragment = Readonly<{ text: string; error?: string }>;

const authenticationKeys = new Set([
  "access_token", "refresh_token", "token_type", "expires_in", "expires_at",
  "provider_token", "provider_refresh_token", "token_hash", "type", "code", "state",
  "error", "error_code", "error_description",
]);

function decode(value: string): string {
  // Shortcuts may encode spaces as either percent escapes or form-style pluses.
  return decodeURIComponent(value.replace(/\+/g, " "));
}

function failure(error: string): ScreenshotFragment {
  // Never retain a partial/truncated receipt which could look valid to a parser.
  return { text: "", error };
}

/** Returns null for fragments outside this channel, including auth callbacks. */
export function parseScreenshotFragment(hash: string): ScreenshotFragment | null {
  if (!hash.startsWith("#")) return null;
  const parts = hash.slice(1).split("&");
  const firstKey = parts[0].split("=", 1)[0];
  // Old installed shortcuts use alipay-screenshot. Both names only transport
  // OCR text: neither is evidence of which app or payment platform it came from.
  if (!SCREENSHOT_KEYS.has(firstKey)) return null;

  // A malformed mixed link must not consume the SDK's login/recovery callback.
  let malformedKey = false;
  for (const part of parts) {
    try {
      if (authenticationKeys.has(decode(part.split("=", 1)[0]))) return null;
    } catch {
      malformedKey = true;
    }
  }
  if (malformedKey) return failure("截图链接格式不正确，请重新运行截图快捷指令。");
  if (parts.length !== 1 || !parts[0].startsWith(`${firstKey}=`)) {
    return failure("截图链接参数不正确，请每次传入一份截图文字。");
  }

  const encoded = parts[0].slice(firstKey.length + 1);
  // One UTF-16 code unit needs at most 12 URL characters when percent encoded.
  if (encoded.length > MAX_SCREENSHOT_TEXT_LENGTH * 12) {
    return failure("截图文字过长，请只截取一笔付款详情后重试。");
  }
  let text: string;
  try { text = decode(encoded); }
  catch { return failure("截图链接编码不正确，请使用 URL 编码操作后重试。"); }
  if (!text.trim()) return failure("没有收到截图文字，请检查截图及文字识别结果。");
  if (text.length > MAX_SCREENSHOT_TEXT_LENGTH) {
    return failure("截图文字过长，请只截取一笔付款详情后重试。");
  }
  if (text.includes("\u0000")) return failure("截图文字包含无效字符，请重新识别后重试。");
  return { text };
}

type ScreenshotIntakeEnvironment = {
  location: Pick<Location, "hash" | "pathname" | "search">;
  history: Pick<History, "state" | "replaceState">;
  addEventListener: (type: "hashchange", listener: () => void) => void;
};

/** A small memory store; constructing/importing it does not access the browser. */
export function createScreenshotIntake(getEnvironment: () => ScreenshotIntakeEnvironment | undefined) {
  let initialized = false;
  let snapshot: ScreenshotIntake | null = null;
  let nextId = 0;
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of [...listeners]) listener(); };

  function initialize() {
    if (initialized) return;
    const environment = getEnvironment();
    if (!environment) return;
    initialized = true;

    const receive = () => {
      const incoming = parseScreenshotFragment(environment.location.hash);
      if (!incoming) return;
      let result = incoming;
      try {
        // Run before auth/bootstrap consumers; URL fragments never need to be
        // sent to the static host, stored in caches or kept in browser history.
        environment.history.replaceState(environment.history.state, "", `${environment.location.pathname}${environment.location.search}`);
      } catch {
        result = failure("无法清除截图链接，请清除地址中的片段后重新传入截图文字。");
      }
      snapshot = Object.freeze({ id: ++nextId, ...result });
      emit();
    };
    environment.addEventListener("hashchange", receive);
    receive();
  }

  return {
    initialize,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    clear(id: number) {
      if (snapshot?.id !== id) return;
      snapshot = null;
      emit();
    },
  };
}

const intake = createScreenshotIntake(() => typeof window === "undefined" ? undefined : window);

export const initializeScreenshotIntake = intake.initialize;
export const subscribeScreenshotIntake = intake.subscribe;
export const getScreenshotIntake = intake.getSnapshot;
export const clearScreenshotIntake = intake.clear;
