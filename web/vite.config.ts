import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/curio/",
  server: {
    proxy: {
      "/curio/api": { target: "http://127.0.0.1:18088", changeOrigin: false },
      "/curio/media": "http://127.0.0.1:18088",
      "/curio/healthz": "http://127.0.0.1:18088"
    }
  }
});
