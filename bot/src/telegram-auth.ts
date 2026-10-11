import { createHmac, timingSafeEqual } from "node:crypto";

export interface MiniAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface VerifiedInitData {
  user: MiniAppUser;
  startParam: string | null;
  authDate: Date;
}

/**
 * Validates Telegram Mini App initData with the bot token, per
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * Returns null if the signature is wrong, the user is missing, or the data is older than maxAgeSec.
 */
export function verifyInitData(
  initData: string,
  botToken: string,
  maxAgeSec = 24 * 3600,
  now = Date.now(),
): VerifiedInitData | null {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(dataCheckString).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) return null;

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || now / 1000 - authDate > maxAgeSec) return null;

  const userJson = params.get("user");
  if (!userJson) return null;
  let user: MiniAppUser;
  try {
    user = JSON.parse(userJson);
  } catch {
    return null;
  }
  if (typeof user.id !== "number") return null;

  return { user, startParam: params.get("start_param"), authDate: new Date(authDate * 1000) };
}

/** Builds signed initData the way Telegram does. For tests and local Mini App development only. */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const dataCheckString = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}
