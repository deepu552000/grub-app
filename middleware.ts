import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isAdminPage = createRouteMatcher(["/admin(.*)"]);
const isAdminApi = createRouteMatcher(["/api/admin(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isAdminApi(req)) {
    // API routes: don't redirect to a sign-in page, just 401 JSON.
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ ok: false, reason: "Unauthorized" }, { status: 401 });
    }
    return;
  }

  if (isAdminPage(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Admin page + admin API routes only — everything else (incl. the
    // Farcaster mini-app routes) is left untouched so Clerk never
    // interferes with frame loading on mobile.
    "/admin(.*)",
    "/api/admin(.*)",
  ],
};
