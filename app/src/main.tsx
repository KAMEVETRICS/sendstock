import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider } from "@privy-io/react-auth";
import { bsc } from "viem/chains";
import { insideTelegram, mockMode, tg } from "./telegram";
import { MockWalletProvider, PrivyWalletProvider } from "./wallet";
import { ClaimScreen, MyTipsScreen, PayScreen } from "./screens";
import { Notice, Screen } from "./ui";
import "./styles.css";

tg.ready();

function Route() {
  if (!insideTelegram && !mockMode) {
    return (
      <Screen>
        <h1>SendStock</h1>
        <Notice>Open this from Telegram: tap a tip's button in your group chat.</Notice>
      </Screen>
    );
  }
  const param = tg.startParam ?? "";
  const [action, id] = param.split("_", 2);
  if (action === "pay" && id) return <PayScreen tipId={id} />;
  if (action === "claim" && id) return <ClaimScreen tipId={id} />;
  return <MyTipsScreen />;
}

const appId = import.meta.env.VITE_PRIVY_APP_ID as string | undefined;

function App() {
  if (mockMode) {
    return (
      <MockWalletProvider>
        <Route />
      </MockWalletProvider>
    );
  }
  if (!appId) {
    return (
      <Screen>
        <Notice tone="error">VITE_PRIVY_APP_ID is not set.</Notice>
      </Screen>
    );
  }
  return (
    <PrivyProvider
      appId={appId}
      clientId={(import.meta.env.VITE_PRIVY_CLIENT_ID as string | undefined) || undefined}
      config={{
        loginMethods: ["telegram"],
        embeddedWallets: { ethereum: { createOnLogin: "all-users" } },
        supportedChains: [bsc],
        defaultChain: bsc,
        appearance: { theme: window.Telegram?.WebApp?.colorScheme === "dark" ? "dark" : "light" },
      }}
    >
      <PrivyWalletProvider>
        <Route />
      </PrivyWalletProvider>
    </PrivyProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
