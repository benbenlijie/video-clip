import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/wayne/",
  preview: { port: 4174, strictPort: true, host: "0.0.0.0" },
  server: {
    port: 5174,
    strictPort: true,
    host: "0.0.0.0",
    hmr: false,
    allowedHosts: ["watchdeep.net", "www.watchdeep.net"],
    proxy: { "/wayne-api": { target: "http://127.0.0.1:18787", rewrite: (path) => path.replace(/^\/wayne-api/, "") } },
  },
  define: { "import.meta.env.VITE_API_BASE": JSON.stringify("/wayne-api") },
});
