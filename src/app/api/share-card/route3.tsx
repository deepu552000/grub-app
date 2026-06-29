// Save as: src/app/api/share-card/route.tsx
// Generates a dynamic OG image card for sharing Grub on Farcaster.
// Usage: /api/share-card?stage=1&mood=content&xp=240&streak=5&bond=42

import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";

export const runtime = "edge";

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

  const stageData  = stages[stageParam - 1];
  const catSrc     = await catImageDataUri(stageParam, mood, origin);

  const thisMinXp  = stageMinXp[stageParam - 1];
  const nextMinXp  = stageMinXp[stageParam] ?? null;
  const xpProgress = nextMinXp !== null
    ? Math.min(100, Math.round(((xp - thisMinXp) / (nextMinXp - thisMinXp)) * 100))
    : 100;
  const nextTitle  = stageParam < 4 ? stages[stageParam].title : null;

  const [moodBg, moodBorder] = moodAccent(mood);

  return new ImageResponse(
    (
      <div
        style={{
          display:        "flex",
          flexDirection:  "column",
          alignItems:     "center",
          justifyContent: "space-between",
          width:          "100%",
          height:         "100%",
          background:     "linear-gradient(145deg, #0e0c1a 0%, #16112a 55%, #0b0b1c 100%)",
          padding:        "20px 36px 16px",
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

        {/* Header */}
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

        {/* Cat image */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1 }}>
          {catSrc ? (
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

        {/* Stage name + mood pill */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, marginBottom: 14 }}>
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

        {/* Stats row */}
        <div style={{ display: "flex", gap: 16, width: "100%", justifyContent: "center" }}>
          {/* XP box with progress */}
          <div
            style={{
              display: "flex", flexDirection: "column", alignItems: "center",
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.09)",
              borderRadius: 12, padding: "9px 20px", minWidth: 76,
            }}
          >
            <span style={{ fontSize: 17, fontWeight: 800, color: "#e8d8ff" }}>{String(Math.round(xp))}</span>
            <span style={{ fontSize: 10, color: "#7a6a90", letterSpacing: 1.5, marginTop: 2 }}>XP</span>
            <span style={{ fontSize: 9, color: "#9a78c0", marginTop: 3 }}>
              {nextTitle ? `${xpProgress}% → ${nextTitle}` : "MAX STAGE"}
            </span>
          </div>
          {/* Streak box */}
          <div
            style={{
              display: "flex", flexDirection: "column", alignItems: "center",
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.09)",
              borderRadius: 12, padding: "9px 20px", minWidth: 76,
            }}
          >
            <span style={{ fontSize: 17, fontWeight: 800, color: "#e8d8ff" }}>{String(streak)}</span>
            <span style={{ fontSize: 10, color: "#7a6a90", letterSpacing: 1.5, marginTop: 2 }}>STREAK</span>
          </div>
          {/* Bond box */}
          <div
            style={{
              display: "flex", flexDirection: "column", alignItems: "center",
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.09)",
              borderRadius: 12, padding: "9px 20px", minWidth: 76,
            }}
          >
            <span style={{ fontSize: 17, fontWeight: 800, color: "#e8d8ff" }}>{`${bond}%`}</span>
            <span style={{ fontSize: 10, color: "#7a6a90", letterSpacing: 1.5, marginTop: 2 }}>BOND</span>
          </div>
        </div>

      </div>
    ),
    { width: 480, height: 480 },
  );
}
