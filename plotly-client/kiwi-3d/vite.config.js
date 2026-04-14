import { defineConfig } from "vite";

export default defineConfig({
  base: "/3d/",
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});