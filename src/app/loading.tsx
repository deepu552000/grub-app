// app/loading.tsx
//
// Next.js shows this INSTANTLY, as part of the initial static shell, the
// moment navigation starts — before page.tsx's generateMetadata (which
// reads `searchParams` and therefore forces the whole route to render
// dynamically on every request) has even started running server-side.
//
// Why this matters: a plain app open with no ?ref=/share params still hits
// that dynamic render path, so every cold open pays for a live serverless
// invocation before any HTML reaches the browser. On a cold Vercel function
// instance that can take a beat — during that gap there is nothing painted
// yet, so Base App's in-app WebView shows its own default background
// (commonly black) instead of ours. This file removes that gap entirely:
// there's always *something* on screen immediately, matching our real
// loading state and background, regardless of how long the server render
// takes underneath it.
//
// Deliberately styled to match ClientPageInner's own `!hydrated` loading
// screen (Client.tsx) so there's no visible flash/swap between this and
// that once the client component takes over.
export default function Loading() {
  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        minHeight: "100dvh",
        background:
          "radial-gradient(circle at 50% -10%, rgba(255, 255, 255, 0.95), transparent 28rem), linear-gradient(145deg, #fffaf2 0%, #fcefe0 42%, #fdf6ec 100%)",
      }}
    >
      <img
        src="/cats/stage1.webp"
        alt="Grub loading"
        style={{ width: 80, opacity: 0.55 }}
      />
      <p
        style={{
          color: "#b5a49a",
          fontSize: "0.8rem",
          marginTop: 12,
          fontWeight: 600,
        }}
      >
        Loading Grub...
      </p>
    </main>
  );
}
