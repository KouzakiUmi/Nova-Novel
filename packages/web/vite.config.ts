import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 43111,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:43110",
        changeOrigin: false,
      },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          "editor-engine": ["@tiptap/react", "@tiptap/starter-kit"],
          "canvas-engine": ["@xyflow/react"],
        },
      },
    },
  },
});
