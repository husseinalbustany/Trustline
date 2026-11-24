import type { NextConfig } from "next";

const apiUrl = process.env.API_URL ?? "http://localhost:3001";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // The browser calls the API through this app, so both share one origin and
  // session cookies need no cross-site allowances.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
