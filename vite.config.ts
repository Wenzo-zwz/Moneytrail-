import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Project sites on GitHub Pages live below /<repository>/; normal hosting uses /.
const base = process.env.MONEYTRAIL_BASE_PATH || "/";
if (!/^\/(?:[A-Za-z0-9._-]+\/)*$/.test(base)) {
  throw new Error("MONEYTRAIL_BASE_PATH must be a path starting and ending with /.");
}

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Moneytrail · 慢慢记账",
        short_name: "慢慢记账",
        description: "理清每月消费，把钱花得明明白白。",
        lang: "zh-CN",
        start_url: base,
        scope: base,
        display: "standalone",
        background_color: "#0b0b0e",
        theme_color: "#0b0b0e",
        icons: [
          {
            src: `${base}icon.svg`,
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
          {
            src: `${base}pwa-192.png`,
            sizes: "192x192",
            type: "image/png",
            purpose: "any maskable",
          },
          {
            src: `${base}pwa-512.png`,
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
        navigateFallback: `${base}index.html`,
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: { host: "0.0.0.0", port: 5173, strictPort: true },
  preview: { host: "0.0.0.0", port: 4173, strictPort: true },
});
