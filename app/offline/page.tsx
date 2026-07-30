export const dynamic = "force-static";

/**
 * Offline fallback (IMPROVEMENTS B8). Served by the service worker when a
 * navigation fails and nothing for that URL is cached.
 *
 * Deliberately static and dependency-free: it has to render with no network, no
 * session and no data, so it must not touch Supabase or any dynamic API.
 */
export const metadata = { title: "Offline — GN Real Estate OS" };

export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-xl font-semibold text-text-1">You are offline</h1>
      <p className="text-sm text-text-2">
        This screen has not been opened on this device yet, so there is nothing saved to show.
        Screens you have already visited still work without signal.
      </p>
      <p className="text-sm text-text-2">
        Anything you were saving has <strong>not</strong> been sent. Reconnect and try again —
        nothing was lost, and nothing was recorded.
      </p>
    </main>
  );
}
