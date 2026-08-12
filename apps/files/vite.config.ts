import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Built as a relative-path bundle: the desktop app serves it from the
 * `suma://files` privileged scheme, where absolute `/assets/...` URLs would
 * not resolve.
 */
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
});
