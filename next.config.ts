import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle with only the traced-in node_modules —
  // lets deploys ship a prebuilt artifact instead of running `npm ci &&
  // npm run build` on the target server (a small instance).
  output: "standalone",
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
      },
      {
        protocol: "http",
        hostname: "localhost",
      },
    ],
  },
  allowedDevOrigins: ["100.65.201.81"],
  experimental: {
    serverActions: {
      allowedOrigins: ["localhost:4021", "100.65.201.81:4021"],
    },
  },
  // The OAuth consent page grants an app access to the member's content —
  // never let another site frame it and dress up the Allow button.
  async headers() {
    return [
      {
        source: "/oauth/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
  // The members admin page moved from /users to /members (User -> Member
  // terminology cleanup); redirect old bookmarks/links rather than 404 them.
  // Exact-path match, so /api/users (a distinct route) is untouched.
  async redirects() {
    return [{ source: "/users", destination: "/members", permanent: true }];
  },
};

export default nextConfig;
