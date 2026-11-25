/** Per-executor check-in retries. Protocol/auth repair stays inside adapters. */
export const DEFAULT_RETRY_COUNT = 2;
export const MAX_RETRY_COUNT = 5;

export function retryCount(channel, defaultValue = DEFAULT_RETRY_COUNT) {
  const value = channel?.options?.retryCount;
  if (value == null || (typeof value === "string" && value.trim() === "") ||
      !["number", "string"].includes(typeof value)) return defaultValue;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || !Number.isInteger(number)) return defaultValue;
  return Math.min(number, MAX_RETRY_COUNT);
}

export function isPermanentCheckinFailure(result) {
  if (result?.ok || result?.needsBrowser) return false;
  if (result?.retryable === false) return true;
  const status = result?.httpStatus;
  const message = String(result?.message || result?.error || "");
  const code = String(result?.raw?.code || "");
  if (status === 401 || status === 404) return true;
  if (status === 403 && !/cloudflare|challenge|waf|blocked|拦截/i.test(message)) return true;
  if (/too many subrequests|subrequests by single worker invocation/i.test(message)) return true;
  return /AUTH_(?:UNAUTHORIZED|SESSION_REVOKED|SESSION_EXPIRED)/i.test(code) ||
    /缺少[^\n]*(?:凭证|cookie|访问令牌|用户名|密码)|凭证.*(?:无效|失效|过期)|密码.*(?:错误|不正确)|未登录|unauthorized|invalid\s+(?:access\s+|refresh\s+)?token|余额不足|额度不足|连续登录|资格不足|活动已(?:失效|结束)|未配置|接口不存在|未知渠道|不支持/i.test(message);
}

export function shouldRetryCheckin(result) {
  if (result?.ok || result?.needsBrowser || isPermanentCheckinFailure(result)) return false;
  // Repeating the same HTTP request cannot solve an IP/WAF challenge.
  if (result?.httpStatus === 403) return false;
  return true;
}

export function retryDelayMs(retryIndex) {
  return retryIndex === 1 ? 2000 : retryIndex === 2 ? 5000 : 10000;
}

function applyTokens(channel, tokens) {
  const auth = { ...(channel.auth || {}), ...tokens };
  if (channel.type === "newapi" && tokens.accessToken) auth.token = tokens.accessToken;
  if (Object.hasOwn(tokens, "authSession")) delete auth.auth_session;
  return { ...channel, auth };
}

function isAlreadyCheckedIn(result) {
  if (result?.alreadyCheckedIn || result?.result?.alreadyCheckedIn || result?.status?.checkedInToday) return true;
  const raw = result?.raw;
  const text = [
    result?.message,
    result?.error,
    raw?.code,
    raw?.message,
    raw?.msg,
    raw?.error,
    raw?.detail,
    raw?.data?.code,
    raw?.data?.message,
    raw?.data?.msg,
    raw?.data?.error,
    typeof raw === "string" ? raw : "",
  ].filter(Boolean).join(" ");
  if (/not\s+(?:already\s+)?checked\s+in|未签到|尚未签到/i.test(text)) return false;
  return /already[_\s-]+(?:have[_\s-]+)?checked[_\s-]+in(?:[_\s-]+today)?|already[_\s-]+signed[_\s-]+in(?:[_\s-]+today)?|今天(?:已经|已)签到|今日(?:已经|已)签到|已经签到|已签到/i.test(text);
}

export async function runCheckinWithRetry(adapter, channel, extra = {}, {
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  defaultRetryCount = DEFAULT_RETRY_COUNT,
} = {}) {
  const maxAttempts = retryCount(channel, defaultRetryCount) + 1;
  let active = { ...channel, auth: { ...channel.auth } };
  let tokens = {};
  const accept = result => {
    if (result?.tokens) {
      tokens = { ...tokens, ...result.tokens };
      active = applyTokens(active, result.tokens);
    }
  };
  const finish = (result, attempts) => ({ ...result, attempts, maxAttempts,
    ...(Object.keys(tokens).length ? { tokens } : {}),
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let result;
    try {
      result = await adapter.checkin(active, extra);
    } catch (error) {
      result = { ok: false, message: error.message || String(error), httpStatus: error.status };
    }
    if (!result.ok && isAlreadyCheckedIn(result)) {
      const details = result.result && typeof result.result === "object" ? result.result : {};
      result = {
        ...result,
        ok: true,
        needsBrowser: false,
        result: { ...details, success: true, alreadyCheckedIn: true },
        message: result.message || "今日已签到",
      };
    }
    accept(result);
    if (result.ok) {
      if (attempt > 1) result = { ...result, message: `${result.message || "签到成功"}（第 ${attempt}/${maxAttempts} 次尝试成功）` };
      return finish(result, attempt);
    }

    // A failed POST is not proof that it had no effect. Confirm before retry/fallback.
    if (result.httpStatus !== 401 && !isPermanentCheckinFailure(result) && typeof adapter.status === "function") {
      try {
        const state = await adapter.status(active);
        accept(state);
        if (state?.ok && (state.status?.checkedInToday === true || state.result?.alreadyCheckedIn === true)) {
          return finish({ ...result, ok: true, needsBrowser: false, httpStatus: state.httpStatus,
            status: state.status, user: state.user || result.user,
            result: { ...result.result, success: true, alreadyCheckedIn: true,
              reward: state.status?.todayReward ?? result.result?.reward ?? null },
            message: `${state.message || "今日已签到"}（请求失败后状态复查确认，未重复 POST）`,
            raw: { attempt: result.raw, status: state.raw },
          }, attempt);
        }
      } catch { /* Unknown status is never treated as success. */ }
    }
    if (attempt === maxAttempts || !shouldRetryCheckin(result)) {
      if (attempt > 1) result = { ...result, message: `${result.message || "签到失败"}（已尝试 ${attempt}/${maxAttempts} 次）` };
      return finish(result, attempt);
    }
    await sleep(retryDelayMs(attempt));
  }
}
