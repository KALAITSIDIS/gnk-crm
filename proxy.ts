import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, CSP_REPORT_GROUP, CSP_REPORT_PATH } from "@/lib/services/csp";

export default async function proxy(request: NextRequest) {
  // Browsers post CSP violation reports without credentials, so this one path
  // must bypass the auth gate — otherwise every report is redirected to /login
  // and silently lost, which is exactly the state that made the report-only
  // policy decorative. The handler writes nothing to the database.
  if (request.nextUrl.pathname === CSP_REPORT_PATH) {
    return NextResponse.next();
  }

  // Buyer proposal pages (IMPROVEMENTS B3). Doc 01 §4 forbids buyer logins
  // ever, so the tokenised page MUST be reachable without a session — the auth
  // gate below would otherwise bounce every buyer to /login.
  //
  // Kept as narrow as the CSP exemption above: exactly the `/p/` prefix and
  // nothing else. The page holds an anon client that can reach only the two
  // functions migration 0023 grants `anon` by name, so an unauthenticated
  // visitor's reach is "resolve one token" regardless of what this route does.
  if (request.nextUrl.pathname.startsWith("/p/")) {
    return NextResponse.next();
  }

  // The offline fallback (IMPROVEMENTS B8) must be reachable with no session.
  // The service worker precaches it at install time, and behind the auth gate
  // that fetch would store a redirect to /login instead — so the one screen
  // that exists for "you have no network" would itself need the network.
  // It is static and renders no data, so exempting it exposes nothing.
  if (request.nextUrl.pathname === "/offline") {
    return NextResponse.next();
  }

  /**
   * Per-request CSP nonce (IMPROVEMENTS C1). Next reads the nonce out of the
   * `Content-Security-Policy` header we set on the REQUEST and stamps it on its
   * own inline bootstrap scripts; the RESPONSE carries the policy as
   * **Report-Only**, so nothing is blocked while the policy is proven against
   * the real app. `next.config.ts` keeps enforcing `frame-ancestors 'none'`
   * separately, so clickjacking protection is unaffected either way.
   */
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const csp = buildCsp({
    nonce,
    isDev: process.env.NODE_ENV !== "production",
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    sentryDsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  });

  // Rebuilt on each call so it picks up any cookies Supabase just refreshed —
  // `request.cookies.set()` writes through to these headers.
  const withNonce = () => {
    const headers = new Headers(request.headers);
    headers.set("x-nonce", nonce);
    headers.set("Content-Security-Policy", csp);
    return NextResponse.next({ request: { headers } });
  };

  let supabaseResponse = withNonce();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = withNonce();
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Refresh the session — required for server components (do not remove).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isLoginPage = path.startsWith("/login");
  // the second-factor screen is part of signing in, so it must stay reachable
  // while the session is still aal1
  const isMfaVerifyPage = path === "/login/verify";

  // The verify page is only meaningful WITH a session — it upgrades one. An
  // anonymous visitor gets the password form, not a code prompt for an account
  // they haven't identified.
  if (!user && (!isLoginPage || isMfaVerifyPage)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user) {
    // 2FA enforcement (IMPROVEMENTS C2). A session that owes a second factor is
    // authenticated but not yet trusted: hold it on /login/verify rather than
    // signing it out, per the Supabase SSR guidance — the user may simply have
    // closed the tab mid-flow.
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    const owesFactor = aal?.currentLevel === "aal1" && aal?.nextLevel === "aal2";

    if (owesFactor && !isMfaVerifyPage) {
      const url = request.nextUrl.clone();
      url.pathname = "/login/verify";
      url.search = "";
      return NextResponse.redirect(url);
    }
    if (!owesFactor && isMfaVerifyPage) {
      // nothing owed — don't strand the user on a challenge they can't answer
      const url = request.nextUrl.clone();
      url.pathname = "/dashboard";
      return NextResponse.redirect(url);
    }
    if (isLoginPage && !isMfaVerifyPage) {
      const url = request.nextUrl.clone();
      url.pathname = "/dashboard";
      return NextResponse.redirect(url);
    }
  }

  // Report-only: the browser reports what WOULD have been blocked and enforces
  // nothing. Promoting this to `Content-Security-Policy` is a separate,
  // deliberate step once the reports are proven clean.
  supabaseResponse.headers.set("Content-Security-Policy-Report-Only", csp);
  // Pairs with the policy's `report-to` directive for browsers that implement
  // the Reporting API; `report-uri` covers the rest.
  supabaseResponse.headers.set(
    "Reporting-Endpoints",
    `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`,
  );
  return supabaseResponse;
}

export const config = {
  matcher: [
    // Everything except Next.js internals and static assets.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
