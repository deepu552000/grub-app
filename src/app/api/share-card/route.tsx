// Save as: src/app/api/share-card/route.tsx
// Generates a dynamic OG image card for sharing Grub — used from both
// Farcaster clients and Base App, so card copy stays platform-generic.
// Usage: /api/share-card?stage=1&mood=content&xp=240&streak=5&bond=42
// Rendered at 1200x800 (3:2) — Farcaster Mini App embeds require a 3:2 image;
// anything else (e.g. the old 480x480 square) gets center-cropped by the
// client feed, which was clipping the win banner and stats row.
// Spin Wheel win card: add &win=<label> (e.g. "Rare Accessory: Gold Glasses"
// or "+10 XP"), &winId=<segment id> (e.g. "xp10", "freecheckin",
// "rareaccessory" — must match a key in WIN_STYLES below, drives the emoji/
// color for that specific reward type) and, for Rare Accessory wins
// specifically, &rare=1 for the bigger/flashier gold banner treatment.
// Banner copy is playful per-type (see WIN_COPY) instead of a flat "Won: X".
// Any win also gets a glowing colored ring around the cat + a few scattered
// confetti/sparkle particles, both scaling up with how good the win is
// (picked after A/B/C testing — the old flat full-card tint option was cut).

import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";

export const runtime = "edge";

// Per-reward-type banner styling for Spin Wheel wins. Colors mirror
// WHEEL_SEGMENTS in Client.tsx exactly, so the share card reads as "the same
// wheel" rather than inventing a second unrelated palette. rareaccessory
// isn't listed here — it gets its own dedicated bigger/flashier gold+pink
// banner further down (see isRareWin), since it's structurally different
// (bigger box, glow, bracketing emoji) rather than just a recolored pill.
//
// `tier` drives size/prominence:
//   "xp"        — small pill, size step-ups with `scale` (xp1 smallest, xp10 largest)
//   "highlight" — bigger, bolder banner w/ soft glow (freecheckin, streaksave —
//                 meaningfully better than a few XP, so they read as a step up
//                 without stealing the rare-accessory gold-banner treatment)
const WIN_STYLES: Record<
  string,
  { emoji: string; bg: string; border: string; text: string; tier: "xp" | "highlight"; scale: number }
> = {
  xp1:         { emoji: "✨", bg: "rgba(245,185,66,0.16)",  border: "rgba(245,185,66,0.4)",  text: "#ffe9b8", tier: "xp", scale: 0 },
  xp2:         { emoji: "✨", bg: "rgba(242,153,74,0.16)",  border: "rgba(242,153,74,0.4)",  text: "#ffdcb8", tier: "xp", scale: 1 },
  xp3:         { emoji: "⚡", bg: "rgba(235,87,87,0.16)",   border: "rgba(235,87,87,0.4)",   text: "#ffc9c9", tier: "xp", scale: 2 },
  xp5:         { emoji: "⚡", bg: "rgba(187,107,217,0.16)", border: "rgba(187,107,217,0.4)", text: "#eccbff", tier: "xp", scale: 3 },
  xp10:        { emoji: "🔥", bg: "rgba(238,66,102,0.18)",  border: "rgba(238,66,102,0.45)", text: "#ffc7d1", tier: "xp", scale: 4 },
  freecheckin: { emoji: "🎁", bg: "rgba(46,196,241,0.20)",  border: "rgba(46,196,241,0.5)",  text: "#d8f4ff", tier: "highlight", scale: 0 },
  streaksave:  { emoji: "🛡️", bg: "rgba(39,174,96,0.20)",  border: "rgba(39,174,96,0.5)",   text: "#d8ffe6", tier: "highlight", scale: 0 },
  // Plain "Share My Grub" bonus (not a Spin Wheel win) — reuses the small xp
  // pill treatment at the smallest size, since it's a flat +1 XP every time.
  share:       { emoji: "📤", bg: "rgba(245,185,66,0.16)",  border: "rgba(245,185,66,0.4)",  text: "#ffe9b8", tier: "xp", scale: 0 },
};
const DEFAULT_WIN_STYLE = {
  emoji: "🎡", bg: "rgba(255,255,255,0.08)", border: "rgba(255,255,255,0.2)", text: "#e8e0f5",
  tier: "xp" as const, scale: 0,
};

// Playful/cute copy per reward type, swapped in for the flat "Won: X" line.
// For the "xp" tier we still append the raw win label in parens (e.g. "(+10 XP)")
// since the exact number matters; "highlight" copy already says everything.
const WIN_COPY: Record<string, string> = {
  xp1:         "Grub found a crumb!",
  xp2:         "Grub snagged a snack!",
  xp3:         "Grub pounced!",
  xp5:         "Grub's feeling lucky!",
  xp10:        "Grub hit the jackpot bowl!",
  freecheckin: "Grub scored a free check-in!",
  streaksave:  "Grub's got your back — streak saved!",
  share:       "Thanks for sharing Grub!",
};

// Rare Accessory gets its own dedicated headline on the simple/referral-style
// card (see isSimple below) instead of reusing the flat "Won: X" line — it's
// the best reward tier, so it gets the best copy.
const RARE_COPY = "Grub struck gold! ✨🏆";

// WIN_STYLES.text values (pastel) are tuned for the full card's dark
// gradient background and are unreadable on the simple card's light cream
// background. This gives each win type a readable dark accent color instead,
// used only by the isSimple headline below.
const WIN_TEXT_LIGHT: Record<string, string> = {
  xp1:         "#b45309",
  xp2:         "#c2410c",
  xp3:         "#b91c1c",
  xp5:         "#7c3aed",
  xp10:        "#be123c",
  freecheckin: "#0369a1",
  streaksave:  "#15803d",
  share:       "#b45309",
};
const DEFAULT_TEXT_LIGHT = "#5a4636";

// Darker variants of the freecheckin/streaksave colors above, used only for
// the highlight-tier pill text. The regular WIN_TEXT_LIGHT shades read fine
// at full 1200px size but wash out once the pill is scaled down to a feed
// thumbnail — these trade a little brand-color nuance for contrast.
const WIN_TEXT_HIGHLIGHT_LIGHT: Record<string, string> = {
  freecheckin: "#0c4a6e",
  streaksave:  "#14532d",
};

// Bare RGB triples (no alpha) for the ring-glow and confetti effects below,
// which each need to build their own alpha/blur values rather than reuse the
// fixed alphas baked into WIN_STYLES.bg/border. Mirrors the same
// WHEEL_SEGMENTS colors as WIN_STYLES.
const WIN_RGB: Record<string, string> = {
  xp1: "245,185,66",
  xp2: "242,153,74",
  xp3: "235,87,87",
  xp5: "187,107,217",
  xp10: "238,66,102",
  freecheckin: "46,196,241",
  streaksave: "39,174,96",
  share: "245,185,66",
};
const RARE_RGB = "255,120,170";
const DEFAULT_RGB = "170,130,255";

// Bumps the alpha channel of an "rgba(r,g,b,a)" string to a new fixed value,
// regardless of what the original alpha was. Used below to punch up the
// simple-card win pills (xp/highlight/rare) for feed-thumbnail legibility —
// a plain string.replace("0.16", ...) is fragile since WIN_STYLES entries
// don't all share the same base alpha (0.16 vs 0.18 vs 0.20 etc).
function boostAlpha(rgba: string, alpha: number): string {
  return rgba.replace(/[\d.]+\)$/, `${alpha})`);
}

// xp tier: 5 size steps (scale 0→4) so a +10 XP win visibly outsizes a +1 XP win
// without touching the highlight/rare tiers.
const XP_SCALE_STEPS = [
  { fontSize: 12, emojiSize: 13, padding: "4px 12px" },
  { fontSize: 12, emojiSize: 13, padding: "5px 13px" },
  { fontSize: 13, emojiSize: 14, padding: "5px 14px" },
  { fontSize: 14, emojiSize: 16, padding: "6px 15px" },
  { fontSize: 15, emojiSize: 18, padding: "7px 17px" },
];

// Confetti particle layout — fixed positions (percent of card) so results
// are deterministic; `count` slices into this list based on win intensity.
const CONFETTI_POSITIONS = [
  { top: "8%",  left: "8%"  }, { top: "15%", left: "34%" }, { top: "6%",  left: "60%" },
  { top: "22%", left: "82%" }, { top: "70%", left: "10%" }, { top: "78%", left: "38%" },
  { top: "68%", left: "88%" }, { top: "40%", left: "3%"  },
];

// IMPORTANT: next/og (Satori) has unreliable WebP decoding in the edge runtime.
// The live game UI can keep using .webp, but for this OG card we need PNG copies
// of the 12 cat stage images at /public/cats-og/<file>.png (same naming as below).
//   stage1.png  = content / smug
//   stage1a.png = hungry
//   stage1b.png = sleepy
//   stage1c.png = feral
function catImageSrc(stage: number, mood: string, origin: string): string {
  const suffix = mood === "hungry" ? "a" : mood === "sleepy" ? "b" : mood === "feral" ? "c" : "";
  return `${origin}/cats-og/stage${stage}${suffix}.png`;
}

const stages = [
  { name: "Tiny Cloud",      title: "Newborn"      },
  { name: "Pocket Purr",     title: "Kitten"       },
  { name: "Pearl Floof",     title: "Young Cat"    },
  { name: "Moonmilk Mythic", title: "Adult Mythic" },
];

const stageMinXp = [0, 480, 960, 1440];

function moodEmoji(mood: string) {
  return { content: "🤍", smug: "✨", hungry: "🍼", feral: "🌑", sleepy: "💤" }[mood] ?? "🤍";
}
function moodLabel(mood: string) {
  return { content: "Content", smug: "Thriving", hungry: "Hungry", feral: "Feral", sleepy: "Sleepy" }[mood] ?? "Content";
}
function moodAccent(mood: string): [string, string] {
  if (mood === "feral")  return ["rgba(180,40,40,0.28)",   "rgba(220,60,60,0.45)"];
  if (mood === "smug")   return ["rgba(255,200,80,0.20)",  "rgba(255,210,80,0.40)"];
  if (mood === "sleepy") return ["rgba(80,80,190,0.25)",   "rgba(110,110,210,0.40)"];
  if (mood === "hungry") return ["rgba(200,100,40,0.22)",  "rgba(220,130,60,0.38)"];
  return                        ["rgba(160,140,255,0.16)", "rgba(180,160,255,0.32)"];
}

async function catImageDataUri(stage: number, mood: string, origin: string): Promise<string | null> {
  const url = catImageSrc(stage, mood, origin);
  try {
    // Hard timeout on this self-fetch (edge function calling back to its own
    // origin for the PNG asset). Without this, a slow or hung origin request
    // has no ceiling — the whole share-card response (and, by extension,
    // anything waiting on it, like a host unfurling this URL before
    // launching the mini app) blocks for as long as the fetch takes. Same
    // "never trust an async call to settle on its own" pattern used
    // throughout Client.tsx (see silentlyDetectWallet, getFcProviderWithTimeout).
    const res = await Promise.race([
      fetch(url),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
    ]);
    if (!res || !res.ok) return null;
    const buf = await res.arrayBuffer();
    const base64 = Buffer.from(buf).toString("base64");
    return `data:image/png;base64,${base64}`;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const { searchParams, origin } = new URL(req.url);

  const stageParam = Math.min(Math.max(parseInt(searchParams.get("stage") ?? "1", 10), 1), 4);
  const mood       = searchParams.get("mood")   ?? "content";
  const xp         = parseInt(searchParams.get("xp")     ?? "0", 10);
  const streak     = parseInt(searchParams.get("streak") ?? "0", 10);
  const bond       = parseInt(searchParams.get("bond")   ?? "0", 10);
  // Spin Wheel win banner — optional. `win` is the human-readable reward
  // label (e.g. "Rare Accessory: Gold Glasses", "+10 XP", "Free Check-in").
  // `rare` flips on the bigger/flashier gold treatment for Rare Accessory
  // wins specifically, per the "every win, but bigger for rare wins" design.
  const win        = searchParams.get("win");
  const winId      = searchParams.get("winId");
  const isRareWin  = searchParams.get("rare") === "1";
  const winStyle   = winId ? (WIN_STYLES[winId] ?? DEFAULT_WIN_STYLE) : DEFAULT_WIN_STYLE;
  const winRgb     = isRareWin ? RARE_RGB : (winId && WIN_RGB[winId]) || DEFAULT_RGB;
  const winText    = winId && WIN_COPY[winId]
    ? (winStyle.tier === "xp" ? `${WIN_COPY[winId]} (${win})` : WIN_COPY[winId])
    : (win ? `Won: ${win}` : "");
  // Tint/particle intensity scales with how good the win is.
  const winIntensity = isRareWin ? 3 : winStyle.tier === "highlight" ? 2 : winStyle.scale >= 3 ? 1.5 : 1;

  const stageData  = stages[stageParam - 1];
  const catSrc     = await catImageDataUri(stageParam, mood, origin);

  // Cat-only card — used for BOTH the referral share link (no win params —
  // plain "here's my current cat") and Spin Wheel win shares (win/winId/rare
  // present — same cat layout, plus a short cute headline above it). Same
  // 1200x800 canvas and background gradient as the full card (keeps the 3:2
  // ratio Farcaster Mini App embeds require).
  // Usage: /api/share-card?stage=2&mood=sleepy&simple=1
  //        /api/share-card?stage=2&mood=sleepy&simple=1&win=%2B10+XP&winId=xp10
  const isSimple = searchParams.get("simple") === "1";
  if (isSimple) {
    return new ImageResponse(
      (
        <div
          style={{
            display:        "flex",
            flexDirection:  "column",
            alignItems:     "center",
            justifyContent: "center",
            width:          "100%",
            height:         "100%",
            gap:            30,
            // Matches the in-app background (same cream used for splashBackgroundColor
            // in page.tsx and the referral/link boxes), not the dark stat-card gradient —
            // this card is meant to look like "here's what the app looks like", not a
            // separate stats-graphic style.
            background:     "radial-gradient(circle at 50% 42%, #fbf7f0 0%, #f5f0e8 55%, #efe7d8 100%)",
            fontFamily:     "sans-serif",
            position:       "relative",
            overflow:       "hidden",
          }}
        >
          {win && (
            isRareWin ? (
              <div
                style={{
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 10,
                  background: "linear-gradient(90deg, rgba(255,60,172,0.28) 0%, rgba(255,200,80,0.38) 50%, rgba(255,60,172,0.28) 100%)",
                  border: "3px solid rgba(255,200,110,0.9)",
                  borderRadius: 22,
                  padding: "22px 46px",
                  boxShadow: "0 0 34px rgba(255,180,90,0.4)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 32, display: "flex" }}>🎉</span>
                  <span style={{ fontSize: 32, fontWeight: 900, color: "#7a3e0a", letterSpacing: 0.3 }}>
                    {RARE_COPY}
                  </span>
                  <span style={{ fontSize: 32, display: "flex" }}>🎉</span>
                </div>
                <span style={{ fontSize: 20, fontWeight: 700, color: "#8a5420" }}>
                  {win.replace(/^Rare Accessory:\s*/i, "")}
                </span>
              </div>
            ) : (
              <div
                style={{
                  display: "flex", alignItems: "center", gap: winStyle.tier === "highlight" ? 14 : 12,
                  // Both tiers get a punched-up fill/border/glow vs. the raw
                  // WIN_STYLES values — those alphas were tuned for the full
                  // 1200px card and were near-invisible once Farcaster/Base
                  // scale this down to a feed thumbnail (see screenshot).
                  background: boostAlpha(winStyle.bg, winStyle.tier === "highlight" ? 0.34 : 0.3),
                  border: `${winStyle.tier === "highlight" ? 3 : 2}px solid ${
                    boostAlpha(winStyle.border, winStyle.tier === "highlight" ? 0.85 : 0.75)
                  }`,
                  borderRadius: winStyle.tier === "highlight" ? 22 : 18,
                  padding: winStyle.tier === "highlight" ? "20px 38px" : "14px 28px",
                  boxShadow: `0 0 ${winStyle.tier === "highlight" ? 26 : 18}px rgba(${winRgb},${
                    winStyle.tier === "highlight" ? 0.35 : 0.25
                  })`,
                }}
              >
                <span style={{ fontSize: winStyle.tier === "highlight" ? 30 : 24, display: "flex" }}>
                  {winStyle.emoji}
                </span>
                <span
                  style={{
                    fontSize: winStyle.tier === "highlight" ? 27 : 21,
                    fontWeight: winStyle.tier === "highlight" ? 900 : 800,
                    letterSpacing: 0.2,
                    color: winStyle.tier === "highlight"
                      ? WIN_TEXT_HIGHLIGHT_LIGHT[winId ?? ""] ?? DEFAULT_TEXT_LIGHT
                      : WIN_TEXT_LIGHT[winId ?? ""] ?? DEFAULT_TEXT_LIGHT,
                  }}
                >
                  {winText}
                </span>
              </div>
            )
          )}

          {catSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={catSrc}
              alt="Grub"
              width={win ? 460 : 520}
              height={win ? 460 : 520}
              style={{ objectFit: "contain" }}
            />
          ) : (
            <span style={{ fontSize: 220, display: "flex" }}>🐾</span>
          )}
        </div>
      ),
      {
        width: 1200,
        height: 800,
        // Same stage+mood+simple(+win) combo is generated identically every
        // time — no reason to re-run the self-fetch + base64 encode on every
        // single open/share. Cached at the edge, so repeat opens of the same
        // referral or win-share link serve instantly instead of repeating
        // the full generation path.
        headers: { "Cache-Control": "public, immutable, max-age=86400" },
      },
    );
  }

  const thisMinXp  = stageMinXp[stageParam - 1];
  const nextMinXp  = stageMinXp[stageParam] ?? null;
  const xpProgress = nextMinXp !== null
    ? Math.min(100, Math.round(((xp - thisMinXp) / (nextMinXp - thisMinXp)) * 100))
    : 100;
  const nextTitle  = stageParam < 4 ? stages[stageParam].title : null;

  const [moodBg, moodBorder] = moodAccent(mood);

  // Build the 4 stat pills — last one is next-stage progress (or MAX if final stage)
  const stats = [
    { label: "XP",     value: String(Math.round(xp)) },
    { label: "STREAK", value: String(streak)          },
    { label: "BOND",   value: `${bond}%`              },
    nextTitle
      ? { label: `→ ${nextTitle.toUpperCase()}`, value: `${xpProgress}%` }
      : { label: "STAGE",                         value: "MAX"            },
  ];

  return new ImageResponse(
    (
      <div
        style={{
          display:        "flex",
          flexDirection:  "row",
          alignItems:     "center",
          width:          "100%",
          height:         "100%",
          background:     "linear-gradient(145deg, #0e0c1a 0%, #16112a 55%, #0b0b1c 100%)",
          padding:        "40px 56px",
          fontFamily:     "sans-serif",
          position:       "relative",
          overflow:       "hidden",
        }}
      >
        {/* Soft radial glow behind cat */}
        <div
          style={{
            position:   "absolute",
            top: "50%", left: "23%",
            transform:  "translate(-50%, -50%)",
            width: 480,  height: 480,
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(190,160,255,0.16) 0%, transparent 70%)",
            display:    "flex",
          }}
        />

        {/* Confetti scatter — more particles for bigger wins */}
        {win && CONFETTI_POSITIONS.slice(0, Math.round(2 + winIntensity * 2)).map((pos, i) => (
          <span
            key={i}
            style={{
              position: "absolute",
              top: pos.top, left: pos.left,
              fontSize: 20 + winIntensity * 4,
              display: "flex",
              opacity: 0.85,
            }}
          >
            {i % 2 === 0 ? winStyle.emoji : "✨"}
          </span>
        ))}

        {/* ── Left: cat + stage name + mood ── */}
        <div
          style={{
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            gap: 14, width: 420, flexShrink: 0,
          }}
        >
          {catSrc ? (
            win ? (
              <div
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 300 + winIntensity * 16, height: 300 + winIntensity * 16,
                  borderRadius: "50%",
                  border: `${2 + Math.round(winIntensity)}px solid rgba(${winRgb},0.55)`,
                  boxShadow: `0 0 ${20 + winIntensity * 14}px rgba(${winRgb},0.45)`,
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={catSrc}
                  alt="Grub"
                  width={300}
                  height={300}
                  style={{ objectFit: "contain" }}
                />
              </div>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={catSrc}
                alt="Grub"
                width={300}
                height={300}
                style={{ objectFit: "contain" }}
              />
            )
          ) : (
            <span style={{ fontSize: 140, display: "flex" }}>🐾</span>
          )}
          <span style={{ fontSize: 32, fontWeight: 800, color: "#f0e8ff", letterSpacing: 0.4 }}>
            {stageData.name}
          </span>
          <div
            style={{
              display: "flex", alignItems: "center", gap: 7,
              background: moodBg, border: `1px solid ${moodBorder}`,
              borderRadius: 18, padding: "5px 16px",
            }}
          >
            <span style={{ fontSize: 16, display: "flex" }}>{moodEmoji(mood)}</span>
            <span style={{ fontSize: 15, color: "#ddd0ff", fontWeight: 500 }}>{moodLabel(mood)}</span>
          </div>
        </div>

        {/* ── Right: header, win banner, stats ── */}
        <div style={{ display: "flex", flexDirection: "column", flex: 1, height: "100%", justifyContent: "center", gap: 22 }}>
          {/* Header */}
          <div style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 9 }}>
              <span style={{ fontSize: 26, fontWeight: 800, color: "#e8d8ff", letterSpacing: 2 }}>GRUB</span>
              <span style={{ fontSize: 14, color: "#7a6a9a", letterSpacing: 1 }}>Virtual Cat Companion</span>
            </div>
            <div
              style={{
                display: "flex", alignItems: "center",
                background: "rgba(170,130,255,0.14)",
                border: "1px solid rgba(170,130,255,0.28)",
                borderRadius: 22, padding: "6px 16px",
              }}
            >
              <span style={{ fontSize: 14, color: "#c4a8ff", fontWeight: 600 }}>
                Stage {stageParam} · {stageData.title}
              </span>
            </div>
          </div>

          {/* Spin Wheel win banner (optional) */}
          {win && (
            isRareWin ? (
              <div
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
                  width: "100%",
                  background: "linear-gradient(90deg, rgba(255,60,172,0.28) 0%, rgba(255,200,80,0.28) 50%, rgba(255,60,172,0.28) 100%)",
                  border: "2px solid rgba(255,210,120,0.65)",
                  borderRadius: 18,
                  padding: "16px 20px",
                  boxShadow: "0 0 32px rgba(255,180,90,0.35)",
                }}
              >
                <span style={{ fontSize: 28, display: "flex" }}>🎉</span>
                <span style={{ fontSize: 24, fontWeight: 800, color: "#fff3da", letterSpacing: 0.3 }}>
                  WON: {win}
                </span>
                <span style={{ fontSize: 28, display: "flex" }}>🎉</span>
              </div>
            ) : winStyle.tier === "highlight" ? (
              <div
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
                  width: "100%",
                  background: winStyle.bg,
                  border: `2px solid ${winStyle.border}`,
                  borderRadius: 18,
                  padding: "14px 20px",
                  boxShadow: `0 0 26px ${winStyle.border}`,
                }}
              >
                <span style={{ fontSize: 24, display: "flex" }}>{winStyle.emoji}</span>
                <span style={{ fontSize: 22, fontWeight: 800, color: winStyle.text, letterSpacing: 0.3 }}>
                  {winText}
                </span>
              </div>
            ) : (
              <div
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  background: winStyle.bg,
                  border: `1px solid ${winStyle.border}`,
                  borderRadius: 16,
                  padding: XP_SCALE_STEPS[winStyle.scale]?.padding ?? XP_SCALE_STEPS[0].padding,
                  alignSelf: "flex-start",
                }}
              >
                <span style={{ fontSize: (XP_SCALE_STEPS[winStyle.scale]?.emojiSize ?? XP_SCALE_STEPS[0].emojiSize) + 4, display: "flex" }}>
                  {winStyle.emoji}
                </span>
                <span
                  style={{
                    fontSize: (XP_SCALE_STEPS[winStyle.scale]?.fontSize ?? XP_SCALE_STEPS[0].fontSize) + 4,
                    color: winStyle.text,
                    fontWeight: 600,
                  }}
                >
                  {winText}
                </span>
              </div>
            )
          )}

          {/* Stats row (4 pills) */}
          <div style={{ display: "flex", gap: 14, width: "100%" }}>
            {stats.map(({ label, value }) => (
              <div
                key={label}
                style={{
                  display: "flex", flexDirection: "column", alignItems: "center",
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid rgba(255,255,255,0.09)",
                  borderRadius: 14, padding: "16px 0", minWidth: 0, flex: 1,
                }}
              >
                <span style={{ fontSize: 24, fontWeight: 800, color: "#e8d8ff" }}>{value}</span>
                <span style={{ fontSize: 12, color: "#7a6a90", letterSpacing: 1, marginTop: 4 }}>{label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 800,
      // Same caching rationale as the simple/referral card above — a given
      // stage+mood+xp+streak+bond(+win) combo always renders identically,
      // so cache it rather than re-running the fetch+encode chain on every
      // view/open of the same share.
      headers: { "Cache-Control": "public, immutable, max-age=86400" },
    },
  );
}
