import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// One self-contained IIFE bundle plus one stylesheet, loaded by the existing
// renderer page. No module graph in the window, so the CSP stays script-src
// 'self' with no inline allowance.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../renderer/fleet",
    emptyOutDir: true,
    target: "chrome124",
    cssCodeSplit: false,
    rollupOptions: {
      input: "src/main.tsx",
      output: {
        format: "iife",
        entryFileNames: "fleet.js",
        assetFileNames: "fleet.[ext]",
      },
    },
  },
});
