import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  async headers() {
    return [
      {
        // Cross-origin isolation for the Bolt.DIY tab (/bolt) ONLY, so its embedded
        // WebContainer (in-browser build + live preview) can boot — it needs
        // SharedArrayBuffer, which requires the hosting document to be
        // cross-origin-isolated. Scoped to /bolt so no other tab is affected, and
        // COEP matches bolt.diy's own header (credentialless) so the :5173 iframe loads.
        source: "/bolt",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
        ],
      },
    ];
  },
};

export default nextConfig;
