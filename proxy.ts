import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export default async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

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
          supabaseResponse = NextResponse.next({ request });
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

  if (!user && !isLoginPage) {
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

  return supabaseResponse;
}

export const config = {
  matcher: [
    // Everything except Next.js internals and static assets.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
