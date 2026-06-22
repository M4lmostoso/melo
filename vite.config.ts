import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { readFileSync } from "fs";

const host = process.env.TAURI_DEV_HOST;

// Single source of truth for the app version. package.json is bumped by release-please
// (release-type "node") alongside tauri.conf.json, so the splash screen always matches.
const appVersion = JSON.parse(
  readFileSync(path.resolve(__dirname, "package.json"), "utf-8"),
).version as string;

// Replaces the __APP_VERSION__ token in HTML entries (e.g. splashscreen.html) at
// build and dev-serve time so the displayed version can never drift from package.json.
const injectAppVersion = {
  name: "inject-app-version",
  transformIndexHtml(html: string) {
    return html.replace(/__APP_VERSION__/g, appVersion);
  },
};

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), injectAppVersion],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Strip operational debug logs from production builds so release binaries stay
  // quiet. console.warn/console.error are kept for crash/error diagnostics.
  esbuild: {
    pure: mode === "production" ? ["console.log", "console.debug"] : [],
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        splashscreen: path.resolve(__dirname, "splashscreen.html"),
      },
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
