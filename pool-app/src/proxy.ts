// P0 access gate. Temporary production containment, not real auth.
// Replace with session-based auth in a follow-up lane.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const REALM = "Pool Field Forms";

function unauthorized(): NextResponse {
  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": `Basic realm="${REALM}", charset="UTF-8"`,
      "Cache-Control": "no-store",
    },
  });
}

function failClosed(): NextResponse {
  return new NextResponse("Service Unavailable", {
    status: 503,
    headers: { "Cache-Control": "no-store" },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isProduction(): boolean {
  return (
    process.env.VERCEL_ENV === "production" ||
    process.env.NODE_ENV === "production"
  );
}

export function proxy(request: NextRequest): NextResponse {
  const expectedUser = process.env.APP_ACCESS_USER;
  const expectedPass = process.env.APP_ACCESS_PASSWORD;

  if (!expectedUser || !expectedPass) {
    if (isProduction()) {
      return failClosed();
    }
    return NextResponse.next();
  }

  const auth = request.headers.get("authorization");
  if (!auth || !auth.toLowerCase().startsWith("basic ")) {
    return unauthorized();
  }

  let decoded: string;
  try {
    decoded = atob(auth.slice(6).trim());
  } catch {
    return unauthorized();
  }

  const colonIdx = decoded.indexOf(":");
  if (colonIdx < 0) return unauthorized();
  const user = decoded.slice(0, colonIdx);
  const pass = decoded.slice(colonIdx + 1);

  if (
    !timingSafeEqual(user, expectedUser) ||
    !timingSafeEqual(pass, expectedPass)
  ) {
    return unauthorized();
  }

  return NextResponse.next();
}

// Negative-lookahead matcher: protect everything except a tight set of
// public assets needed for the app shell + PWA install. Server Actions
// POST to their hosting route, so they are covered by the page matchers.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|manifest\\.webmanifest|icon-192\\.png|icon-512\\.png|apple-touch-icon\\.png).*)",
  ],
};
