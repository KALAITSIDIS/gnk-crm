import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, CSP_REPORT_GROUP, CSP_REPORT_PATH } from "@/lib/services/csp";
import { CSP_ECHO_PATH } from "@/lib/services/csp-echo";

export default async function proxy(request: NextRequest) {
  // Browsers post CSP violation reports without credentials, so this one path
  // must bypass the auth gate — otherwise every report is redirected to /login
  // and silently lost, which is exactly the state that made the report-only
  // policy decorative. The handler writes nothing to the database.
  if (request.nextUrl.pathname === CSP_REPORT_PATH) {
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
  // NOTE: both NEXT_PUBLIC_* reads below are INLINED AT BUILD TIME, not read at
  // runtime. Changing either in Vercel therefore requires a build that does not
  // restore the previous build cache — a cached build silently keeps the old
  // value compiled in. That is not theoretical: on 2026-08-03 the Sentry origin
  // stayed missing from connect-src through a READY deployment because the
  // build log said "Restored build cache from previous deployment", and that
  // previous deployment predated the variable being set for Production.
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
    // DO NOT re-add `Content-Security-Policy-Report-Only` here. Next reads the
    // nonce as `content-security-policy || content-security-policy-report-only`
    // (app-render.js → getScriptNonceFromHeader), so setting the second name
    // looks like a free rescue — it was tried in 51e7050, deployed, measured on
    // production, and changed nothing: still 22 script tags and 0 nonces. The
    // drop is not keyed to the header NAME. Evidence in IMPROVEMENTS C1;
    // `/api/csp-echo` is the diagnostic that narrows it further.
    return NextResponse.next({ request: { headers } });
  };

  /**
   * Routes that skip the AUTH gate but must still carry the CSP.
   *
   *  - `/p/*`     buyer proposal pages (B3). Doc 01 §4 forbids buyer logins
   *               ever, so these must be reachable with no session.
   *  - `/offline` the PWA fallback (B8). The service worker precaches it at
   *               install; behind the gate that fetch stores a redirect to
   *               /login, so the one screen for "you have no network" would
   *               itself need the network.
   *
   * These used to `return NextResponse.next()` ABOVE the nonce, which skipped
   * the policy as well as the gate — so the only unauthenticated HTML this app
   * serves was also the only HTML with no `script-src`, which is backwards.
   * Found by diffing the response headers of /login against /p/ in production.
   * Kept exactly as narrow as before: the `/p/` prefix and that one pathname.
   */
  const path = request.nextUrl.pathname;

  /**
   * TEMPORARY (IMPROVEMENTS C1) — and deliberately NOT folded into the public
   * branch below, which would have quietly ruined the measurement.
   *
   * That branch sets `Content-Security-Policy-Report-Only` on the RESPONSE, and
   * **a response header set through `NextResponse.next()` comes back round as a
   * REQUEST header by the time the handler reads it** — measured locally
   * 2026-08-10 with `withNonce()` no longer setting that name at all and the
   * route still reporting it present. A diagnostic that reads its own output
   * answers nothing. This path therefore gets `withNonce()` and nothing else:
   * every header it sees came from the request-header override or from nowhere.
   *
   * No auth gate, for the same reason as `/p/*` — it has to be curl-able with
   * no session. It is safe to expose; see `lib/services/csp-echo.ts`.
   */
  if (path === CSP_ECHO_PATH) return withNonce();

  if (path.startsWith("/p/") || path === "/offline") {
    const publicResponse = withNonce();
    publicResponse.headers.set("Content-Security-Policy-Report-Only", csp);
    publicResponse.headers.set(
      "Reporting-Endpoints",
      `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`,
    );
    return publicResponse;
  }

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
    //
    // `sw.js` and `manifest.webmanifest` are named explicitly (IMPROVEMENTS
    // B8): the extension list below does not cover `.js`/`.webmanifest`, so
    // without this both fell through to the auth gate and answered 307 to
    // /login. A browser fetches the manifest and registers the worker without
    // necessarily carrying credentials, so installing the app failed for
    // anyone not already signed in. Caught in production, not by the local
    // suite, because Playwright's `request` fixture is authenticated.
    // Neither file contains any data.
    "/((?!_next/static|_next/image|favicon.ico|sw\\.js|manifest\\.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
