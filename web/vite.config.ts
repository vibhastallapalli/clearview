import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `host: true` lets a phone on the same network reach the dev server.
// Phone cameras need HTTPS: tunnel this port with ngrok (see README).
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/api": "http://localhost:3001",
      "/files": "http://localhost:3001",
    },
  },
});
