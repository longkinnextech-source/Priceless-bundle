import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Allows a second dev server alongside the main one (used by the E2E suite to
  // run a failure-mode instance against the same database).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // `pg` and `@supabase/supabase-js` are server-only; never bundle them for the browser.
  serverExternalPackages: ["pg", "@supabase/supabase-js"],
  poweredByHeader: false,
};

export default nextConfig;
