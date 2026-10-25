import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: [
        "**/target/**",
        "**/release/**",
        "**/.runtime/**",
        "**/src-tauri/**",
        "**/crates/**",
      ],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
});
