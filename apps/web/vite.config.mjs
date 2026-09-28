import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const webRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: webRoot,
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4173,
    fs: {
      strict: true,
      allow: [webRoot, fileURLToPath(new URL("../../packages", import.meta.url))],
    },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4174",
        changeOrigin: false,
        ws: true,
      },
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
  },
});
