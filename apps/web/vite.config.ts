import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: { "/api": "http://localhost:8787", "/cdn-cgi": "http://localhost:8787" },
  },
  build: { outDir: "dist" },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
