import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: "src/client",
  resolve: {
    alias: {
      "@shared": path.resolve(rootDir, "src/shared")
    }
  },
  plugins: [react()],
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true
  },
  server: {
    port: 5173,
    fs: {
      allow: [path.resolve(rootDir, "src")]
    },
    proxy: {
      "/api": "http://localhost:3000",
      "/auth": "http://localhost:3000"
    }
  }
});
