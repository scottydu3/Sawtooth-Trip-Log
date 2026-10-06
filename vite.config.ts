import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// BASE_PATH is "/<repo>/" on GitHub Pages (set by the deploy workflow), "/" locally.
export default defineConfig({
  base: process.env.BASE_PATH || "/",
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Sawtooth Trip Log",
        short_name: "Trip Log",
        description: "Sales trips, stops, contacts, notes and Outlook reminders.",
        theme_color: "#1f5b4a",
        background_color: "#f3f5f4",
        display: "standalone",
        start_url: ".",
        scope: ".",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        navigateFallback: "index.html",
        globPatterns: ["**/*.{js,css,html,svg,png}"],
      },
    }),
  ],
});
