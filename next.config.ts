import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  // The review pipeline parses code with the TypeScript compiler API at runtime (D9); load it from
  // node_modules instead of bundling the ~9 MB compiler into the server build.
  serverExternalPackages: ["typescript"],
};

export default nextConfig;
