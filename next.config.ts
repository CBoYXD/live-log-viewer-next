import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Conditional standalone output keeps `bun run build && bun start` warning-free while packaging can still opt in.
  output: process.env.LLV_STANDALONE === "1" ? "standalone" : undefined,
  images: { unoptimized: true },
  outputFileTracingExcludes: {
    "*": ["node_modules/@img/**", "node_modules/sharp/**"],
  },
};

export default nextConfig;
