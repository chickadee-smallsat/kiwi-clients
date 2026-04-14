import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  base: "/3d/",
  build: {
    outDir: path.resolve(__dirname, "../plotly-client/web/3d"),
    emptyOutDir: true
  }
});