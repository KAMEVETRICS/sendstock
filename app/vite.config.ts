import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // Read VITE_* variables from the repo-root .env shared with the bot.
  const env = loadEnv(mode, "..", "VITE_");

  // Everything prefixed VITE_ ships in the public bundle. Refuse to build with a secret in it.
  for (const [key, value] of Object.entries(env)) {
    if (/secret|private/i.test(key) || /^privy_app_secret_/i.test(value) || /^0x[0-9a-f]{64}$/i.test(value)) {
      throw new Error(`${key} looks like a secret. VITE_ variables are public; remove it from .env.`);
    }
  }
  if (env.VITE_PRIVY_CLIENT_ID && !env.VITE_PRIVY_CLIENT_ID.startsWith("client-")) {
    throw new Error("VITE_PRIVY_CLIENT_ID should start with \"client-\" (Privy dashboard → App clients). Leave it empty if unsure.");
  }

  return {
    plugins: [react()],
    envDir: "..",
    server: {
      port: 5173,
      proxy: { "/api": "http://localhost:8787" },
    },
  };
});
