// Thin typed wrapper over window.Telegram.WebApp (loaded by telegram-web-app.js in index.html).

interface WebApp {
  initData: string;
  initDataUnsafe: { start_param?: string; user?: { id: number; first_name: string; username?: string } };
  ready(): void;
  expand(): void;
  close(): void;
  openLink(url: string): void;
  colorScheme: "light" | "dark";
  HapticFeedback?: { notificationOccurred(type: "error" | "success" | "warning"): void };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: WebApp };
  }
}

const webApp: WebApp | undefined = window.Telegram?.WebApp;

/** Dev-only preview: open http://localhost:5173/?mock=pay (or claim, list) outside Telegram. */
export const mockMode: "pay" | "claim" | "list" | null = (() => {
  if (!import.meta.env.DEV) return null;
  const m = new URLSearchParams(location.search).get("mock");
  return m === "pay" || m === "claim" || m === "list" ? m : null;
})();

export const insideTelegram = !!webApp?.initData;

export const tg = {
  initData: webApp?.initData ?? "",
  startParam:
    webApp?.initDataUnsafe.start_param ??
    // web_app buttons in private chats open the URL directly, so the tip comes in as ?start=
    new URLSearchParams(location.search).get("start") ??
    (mockMode === "pay" ? "pay_mockTip0001" : mockMode === "claim" ? "claim_mockTip0001" : null),
  ready() {
    webApp?.ready();
    webApp?.expand();
  },
  close() {
    webApp?.close();
  },
  openLink(url: string) {
    if (webApp) webApp.openLink(url);
    else window.open(url, "_blank", "noopener");
  },
  haptic(type: "error" | "success" | "warning") {
    webApp?.HapticFeedback?.notificationOccurred(type);
  },
};
