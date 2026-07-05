// Filters one specific, confirmed-harmless log line from the server console.
//
// During Next.js's server-side render pass, @farcaster/miniapp-sdk's
// internal telemetry init runs once in Node (no `window`), throws inside an
// unawaited Promise, and surfaces as an unhandledRejection. It never affects
// rendering (the page already served a 200 before this fires) and never runs
// in the browser — Farcaster mini app, Base app, and plain browser usage all
// execute the SDK in the actual browser context where it works normally.
//
// This only swallows that exact message. Every other error/rejection still
// logs to the console as usual, and nothing here changes how the app,
// wallet flow, or SDK calls behave.
export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    process.on("unhandledRejection", (reason: unknown) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (message.includes("Telemetry is not supported in non-browser environments")) {
        return; // known-harmless, server-render-only SDK telemetry init
      }
      console.error("Unhandled Rejection:", reason);
    });
  }
}
