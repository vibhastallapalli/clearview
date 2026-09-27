import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `host: true` lets a phone on the same network reach the dev server.
// Phone cameras need HTTPS: tunnel this port with ngrok (see README).
// CLEARDOCK_API points the dev proxy at another server (e.g. an isolated QA stack).
const API = process.env.CLEARDOCK_API || "http://localhost:3001";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/api": API,
      "/files": API,
    },
  },
});
