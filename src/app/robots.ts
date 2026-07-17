// app/robots.ts
//
// Next.js App Router metadata route — generates /robots.txt automatically
// at build/request time (no static file needed). Scoped for Grub:
//   - Allow "/" (the mini app itself) so it can be indexed/discovered.
//   - Disallow "/admin" and "/api" — not a security boundary (Clerk auth
//     is what actually protects /admin, and /api routes validate their
//     own inputs regardless), just keeps well-behaved crawlers from
//     spending crawl budget on JSON endpoints and dashboard pages, and
//     keeps them out of search results.

import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin", "/api"],
    },
    // No sitemap line — Grub is a single-page app (just "/"), so there's
    // nothing extra for a sitemap to help crawlers discover.
  };
}
