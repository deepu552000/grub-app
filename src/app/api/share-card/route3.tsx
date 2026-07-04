// Save as: src/app/api/share-card/route.tsx
// Generates a dynamic OG image card for sharing Grub on Farcaster.
// Usage: /api/share-card?stage=1&mood=content&xp=240&streak=5&bond=42
// Spin Wheel win card: add &win=<label> (e.g. "Rare Accessory: Gold Glasses"
// or "+10 XP"), &winId=<segment id> (e.g. "xp10", "freecheckin",
// "rareaccessory" — must match a key in WIN_STYLES below, drives the emoji/
// color for that specific reward type) and, for Rare Accessory wins
// specifically, &rare=1 for the bigger/flashier gold banner treatment.

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
};
const DEFAULT_WIN_STYLE = {
  emoji: "🎡", bg: "rgba(255,255,255,0.08)", border: "rgba(255,255,255,0.2)", text: "#e8e0f5",
  tier: "xp" as const, scale: 0,
};

// xp tier: 5 size steps (scale 0→4) so a +10 XP win visibly outsizes a +1 XP win
// without touching the highlight/rare tiers.
const XP_SCALE_STEPS = [
  { fontSize: 12, emojiSize: 13, padding: "4px 12px" },
  { fontSize: 12, emojiSize: 13, padding: "5px 13px" },
  { fontSize: 13, emojiSize: 14, padding: "5px 14px" },
  { fontSize: 14, emojiSize: 16, padding: "6px 15px" },
  { fontSize: 15, emojiSize: 18, padding: "7px 17px" },
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
    const res = await fetch(url);
    if (!res.ok) return null;
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

  const stageData  = stages[stageParam - 1];
  const catSrc     = await catImageDataUri(stageParam, mood, origin);

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
          flexDirection:  "column",
          alignItems:     "center",
          justifyContent: "flex-start",
          gap:            12,
          width:          "100%",
          height:         "100%",
          background:     "linear-gradient(145deg, #0e0c1a 0%, #16112a 55%, #0b0b1c 100%)",
          padding:        "18px 32px 18px",
          fontFamily:     "sans-serif",
          position:       "relative",
          overflow:       "hidden",
        }}
      >
        {/* Soft radial glow behind cat */}
        <div
          style={{
            position:   "absolute",
            top: "44%", left: "50%",
            transform:  "translate(-50%, -50%)",
            width: 340,  height: 340,
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(190,160,255,0.14) 0%, transparent 70%)",
            display:    "flex",
          }}
        />

        {/* ── Header ── */}
        <div style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontSize: 20, fontWeight: 800, color: "#e8d8ff", letterSpacing: 2 }}>GRUB</span>
            <span style={{ fontSize: 12, color: "#7a6a9a", letterSpacing: 1 }}>Virtual Cat · Farcaster</span>
          </div>
          <div
            style={{
              display: "flex", alignItems: "center",
              background: "rgba(170,130,255,0.14)",
              border: "1px solid rgba(170,130,255,0.28)",
              borderRadius: 20, padding: "4px 14px",
            }}
          >
            <span style={{ fontSize: 12, color: "#c4a8ff", fontWeight: 600 }}>
              Stage {stageParam} · {stageData.title}
            </span>
          </div>
        </div>

        {/* ── Spin Wheel win banner (optional) ── */}
        {win && (
          isRareWin ? (
            <div
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                width: "100%",
                background: "linear-gradient(90deg, rgba(255,60,172,0.28) 0%, rgba(255,200,80,0.28) 50%, rgba(255,60,172,0.28) 100%)",
                border: "1.5px solid rgba(255,210,120,0.65)",
                borderRadius: 16,
                padding: "8px 12px",
                boxShadow: "0 0 24px rgba(255,180,90,0.35)",
              }}
            >
              <span style={{ fontSize: 20, display: "flex" }}>🎉</span>
              <span style={{ fontSize: 17, fontWeight: 800, color: "#fff3da", letterSpacing: 0.3 }}>
                WON: {win}
              </span>
              <span style={{ fontSize: 20, display: "flex" }}>🎉</span>
            </div>
          ) : winStyle.tier === "highlight" ? (
            <div
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                background: winStyle.bg,
                border: `1.5px solid ${winStyle.border}`,
                borderRadius: 16,
                padding: "7px 18px",
                boxShadow: `0 0 18px ${winStyle.border}`,
              }}
            >
              <span style={{ fontSize: 18, display: "flex" }}>{winStyle.emoji}</span>
              <span style={{ fontSize: 16, fontWeight: 800, color: winStyle.text, letterSpacing: 0.3 }}>
                Won: {win}
              </span>
            </div>
          ) : (
            <div
              style={{
                display: "flex", alignItems: "center", gap: 6,
                background: winStyle.bg,
                border: `1px solid ${winStyle.border}`,
                borderRadius: 14,
                padding: XP_SCALE_STEPS[winStyle.scale]?.padding ?? XP_SCALE_STEPS[0].padding,
              }}
            >
              <span style={{ fontSize: XP_SCALE_STEPS[winStyle.scale]?.emojiSize ?? XP_SCALE_STEPS[0].emojiSize, display: "flex" }}>
                {winStyle.emoji}
              </span>
              <span
                style={{
                  fontSize: XP_SCALE_STEPS[winStyle.scale]?.fontSize ?? XP_SCALE_STEPS[0].fontSize,
                  color: winStyle.text,
                  fontWeight: 600,
                }}
              >
                Won: {win}
              </span>
            </div>
          )
        )}

        {/* ── Cat image ── */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          {catSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={catSrc}
              alt="Grub"
              width={180}
              height={180}
              style={{ objectFit: "contain", filter: "drop-shadow(0 0 20px rgba(200,160,255,0.30))" }}
            />
          ) : (
            <span style={{ fontSize: 96 }}>🐾</span>
          )}
        </div>

        {/* ── Stage name + mood pill ── */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 26, fontWeight: 800, color: "#f0e8ff", letterSpacing: 0.4 }}>
            {stageData.name}
          </span>
          <div
            style={{
              display: "flex", alignItems: "center", gap: 6,
              background: moodBg, border: `1px solid ${moodBorder}`,
              borderRadius: 16, padding: "4px 14px",
            }}
          >
            <span style={{ fontSize: 14, display: "flex" }}>{moodEmoji(mood)}</span>
            <span style={{ fontSize: 13, color: "#ddd0ff", fontWeight: 500 }}>{moodLabel(mood)}</span>
          </div>
        </div>

        {/* ── Stats row (4 pills) ── */}
        <div style={{ display: "flex", gap: 10, width: "100%", justifyContent: "center" }}>
          {stats.map(({ label, value }) => (
            <div
              key={label}
              style={{
                display: "flex", flexDirection: "column", alignItems: "center",
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.09)",
                borderRadius: 12, padding: "9px 0", minWidth: 0, flex: 1,
              }}
            >
              <span style={{ fontSize: 15, fontWeight: 800, color: "#e8d8ff" }}>{value}</span>
              <span style={{ fontSize: 9, color: "#7a6a90", letterSpacing: 1, marginTop: 2 }}>{label}</span>
            </div>
          ))}
        </div>

      </div>
    ),
    { width: 480, height: 480 },
  );
}
