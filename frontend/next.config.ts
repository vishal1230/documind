import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces a minimal self-contained server in .next/standalone (small Docker image).
  output: "standalone",
};

export default nextConfig;
