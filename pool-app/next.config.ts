import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root: a stray package.json in the user's home dir
  // otherwise wins Turbopack's root inference and breaks CSS module
  // resolution (tw-animate-css) in local dev. No effect on Vercel, where
  // the project root is already pool-app.
  turbopack: {
    root: import.meta.dirname,
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
