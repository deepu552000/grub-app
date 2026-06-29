// app/admin/dashboard/page.tsx
// Open at: /admin/dashboard?secret=YOUR_SECRET

"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";

type DebugUser = {
  fid: string;
  xp: number;
  totalCheckIns: number;
  accessoriesUnlockedCount: number;
  accessoriesUnlocked: string[];
  lastVisit: string;
  referrals?: {
    referredBy: number | null;
    referredCount: number;
    referredUsers: { fid: number; checkins: number; status: string }[];
    degenEarned: number;
  };
};

type TxnEntry = {
  fid: number;
  type: "accessory_unlock" | "checkin" | "referral_join" | "referral_checkin";
  txHash: string;
  amountUsd: number;
  amountDegen?: number;
  toFid?: number;
  toWallet?: string;
  accessoryId?: string;
  accessoryName?: string;
  ts: number;
};

// ── Design tokens ────────────────────────────────────────────────────────────
const C = {
  bg:        "#0d0c14",
  surface:   "#13111e",
  surfaceAlt:"#1a1828",
  border:    "#2d2b42",
  borderSub: "#1e1c2e",
  amber:     "#c084fc",
  amberDim:  "#6b21a8",
  amberGlow: "#d8b4fe",
  amberGlow2:"#ede9fe",
  cream:     "#f5f0ff",
  creamDim:  "#c4b5fd",
  creamMute: "#7c6fa0",
  green:     "#34d399",
  greenDim:  "#064e3b",
  blue:      "#60a5fa",
  blueDim:   "#1e3a5f",
  purple:    "#a78bfa",
  red:       "#f87171",
  redDim:    "#450a0a",
  text:      "#ede9fe",
  textSub:   "#a89bc8",
  textMute:  "#5c5478",
};

const TYPE_META: Record<string, { color: string; bg: string; label: string }> = {
  accessory_unlock: { color: C.blue,    bg: C.blueDim,   label: "Accessory" },
  checkin:          { color: C.green,   bg: C.greenDim,  label: "Check-in"  },
  referral_join:    { color: C.amberGlow, bg: "#3b1f6e",  label: "Ref Join"  },
  referral_checkin: { color: C.purple,  bg: "#2e1f5e",   label: "Ref Check" },
};

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function shortAddr(s?: string): string {
  if (!s) return "";
  return s.length > 10 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

// ── Sub-components ───────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, accent, dark = true }: { label: string; value: string; sub?: string; accent?: string; dark?: boolean }) {
  const ac = accent ?? C.amber;
  const surface = dark ? C.surface : "#ffffff";
  const border = dark ? C.border : "#c4b5fd";
  const creamMute = dark ? C.creamMute : "#6d28d9";
  const cream = dark ? C.cream : "#1e1b4b";
  const textSub = dark ? C.textSub : "#4c1d95";
  return (
    <div style={{
      background: surface,
      border: `1px solid ${border}`,
      borderRadius: 12,
      padding: "1.25rem 1.5rem",
      flex: 1,
      minWidth: 160,
      position: "relative",
      overflow: "hidden",
      boxShadow: `0 0 0 1px ${ac}18, inset 0 1px 0 ${ac}22`,
    }}>
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 2,
        background: `linear-gradient(90deg, ${ac}cc, ${ac}55)`,
        borderRadius: "12px 12px 0 0",
        boxShadow: `0 0 12px ${ac}88`,
      }} />
      <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: creamMute, margin: "0 0 8px" }}>{label}</p>
      <p style={{ fontSize: 28, fontWeight: 700, margin: 0, color: cream, lineHeight: 1 }}>{value}</p>
      {sub && <p style={{ fontSize: 12, color: textSub, margin: "6px 0 0" }}>{sub}</p>}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "2rem 0 0.75rem" }}>
      <span style={{ width: 3, height: 14, background: C.amberGlow, borderRadius: 2, display: "block", flexShrink: 0, boxShadow: `0 0 8px ${C.amberGlow}` }} />
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: C.creamDim }}>{children}</span>
    </div>
  );
}

function Badge({ color, bg, children }: { color: string; bg: string; children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 5,
      background: bg, color: color, letterSpacing: "0.04em",
    }}>{children}</span>
  );
}

function Input({ value, onChange, placeholder, onKeyDown }: {
  value: string; onChange: (v: string) => void; placeholder?: string; onKeyDown?: React.KeyboardEventHandler;
}) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      style={{
        flex: 1,
        background: C.bg,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        color: C.text,
        padding: "8px 12px",
        fontSize: 13,
        outline: "none",
        fontFamily: "inherit",
      }}
    />
  );
}

function NumberInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.creamMute, display: "block", marginBottom: 5 }}>{label}</label>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          background: C.bg,
          border: `1px solid ${C.border}`,
          borderRadius: 8,
          color: C.text,
          padding: "7px 10px",
          fontSize: 13,
          boxSizing: "border-box",
          fontFamily: "inherit",
          outline: "none",
        }}
      />
    </div>
  );
}

function Btn({ onClick, disabled, variant = "default", children }: {
  onClick: () => void; disabled?: boolean; variant?: "default" | "green" | "amber" | "red"; children: React.ReactNode;
}) {
  const styles = {
    default: {
      border: `1px solid ${C.border}`,
      color: C.creamDim,
      bg: C.surfaceAlt,
      shadow: "none",
      hoverBg: C.border,
    },
    green: {
      border: `1px solid ${C.green}`,
      color: "#001a0d",
      bg: C.green,
      shadow: `0 0 12px ${C.green}55`,
      hoverBg: "#4dffa0",
    },
    amber: {
      border: `1px solid ${C.amberGlow}`,
      color: "#1a0e00",
      bg: C.amberGlow,
      shadow: `0 0 14px ${C.amberGlow}55`,
      hoverBg: C.amberGlow2,
    },
    red: {
      border: `1px solid ${C.red}`,
      color: C.red,
      bg: C.redDim,
      shadow: `0 0 10px ${C.red}33`,
      hoverBg: "#5c1818",
    },
  }[variant];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: styles.bg,
        border: styles.border,
        borderRadius: 8,
        color: styles.color,
        padding: "8px 16px",
        fontSize: 12,
        fontWeight: 700,
        fontFamily: "inherit",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.38 : 1,
        whiteSpace: "nowrap",
        letterSpacing: "0.03em",
        transition: "opacity 0.15s, box-shadow 0.15s",
        boxShadow: disabled ? "none" : styles.shadow,
      }}
    >{children}</button>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "1.25rem", boxShadow: `inset 0 1px 0 ${C.amberGlow}0a` }}>
      {children}
    </div>
  );
}

// ── Main dashboard ────────────────────────────────────────────────────────────

function AdminDashboardInner() {
  const searchParams = useSearchParams();
  const secret = searchParams.get("secret") ?? "";

  const [users, setUsers] = useState<DebugUser[]>([]);
  const [txns, setTxns] = useState<TxnEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastLoaded, setLastLoaded] = useState<Date | null>(null);
  const [dark, setDark] = useState(true);

  // Toast notifications
  const [toasts, setToasts] = useState<{ id: number; msg: string; type: "success" | "error" }[]>([]);
  const addToast = useCallback((msg: string, type: "success" | "error" = "success") => {
    const id = Date.now();
    setToasts((t) => [...t, { id, msg, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  // Light theme overrides
  const T = dark ? {
    bg: C.bg, surface: C.surface, surfaceAlt: C.surfaceAlt, border: C.border, borderSub: C.borderSub,
    text: C.text, textSub: C.textSub, textMute: C.textMute, cream: C.cream, creamDim: C.creamDim, creamMute: C.creamMute,
  } : {
    bg: "#f5f3ff", surface: "#ffffff", surfaceAlt: "#ede9fe", border: "#c4b5fd", borderSub: "#ddd6fe",
    text: "#1e1b4b", textSub: "#4c1d95", textMute: "#7c3aed", cream: "#1e1b4b", creamDim: "#4c1d95", creamMute: "#6d28d9",
  };

  const [lookupFid, setLookupFid] = useState("");
  const [controlState, setControlState] = useState<any>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [controlLoading, setControlLoading] = useState(false);
  const [controlMsg, setControlMsg] = useState<string | null>(null);
  const [statDrafts, setStatDrafts] = useState({ xp: "", bond: "", glimmer: "", hunger: "", happiness: "" });
  const [accessoryToRevoke, setAccessoryToRevoke] = useState("");
  const [accessoryToUnlock, setAccessoryToUnlock] = useState("");
  const [newReferrerFid, setNewReferrerFid] = useState("");

  const authedGet = useCallback((path: string) => {
    const sep = path.includes("?") ? "&" : "?";
    return fetch(`${path}${sep}secret=${encodeURIComponent(secret)}`).then((r) => r.json());
  }, [secret]);

  const authedPost = useCallback((path: string, body: Record<string, any>) => {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, secret }),
    }).then((r) => r.json());
  }, [secret]);

  const loadUserControl = useCallback(async (fid: string) => {
    if (!fid) return;
    setControlLoading(true);
    setControlError(null);
    setControlMsg(null);
    try {
      const res = await authedGet(`/api/admin/user-control?fid=${encodeURIComponent(fid)}`);
      if (!res.ok) {
        setControlState(null);
        setControlError(res.reason ?? "Could not load user");
      } else {
        setControlState(res);
        setStatDrafts({
          xp: String(res.state.xp), bond: String(res.state.bond),
          glimmer: String(res.state.glimmer), hunger: String(res.state.hunger),
          happiness: String(res.state.happiness),
        });
      }
    } catch (err: any) {
      setControlError(err?.message ?? "Failed to load user");
    } finally {
      setControlLoading(false);
    }
  }, [authedGet]);

  const runAction = useCallback(async (action: string, extra: Record<string, any> = {}) => {
    if (!lookupFid) return;
    setControlMsg(null);
    setControlError(null);
    try {
      const res = await authedPost("/api/admin/user-control", { fid: lookupFid, action, ...extra });
      if (!res.ok) {
        const errMsg = res.reason ?? "Action failed";
        setControlError(errMsg);
        addToast(`✕ ${errMsg}`, "error");
      } else {
        const successMsg = res.warning ? `Done — note: ${res.warning}` : `✓ ${action.replace(/_/g, " ")} applied.`;
        setControlMsg(successMsg);
        addToast(successMsg, "success");
        loadUserControl(lookupFid);
      }
    } catch (err: any) {
      const errMsg = err?.message ?? "Action failed";
      setControlError(errMsg);
      addToast(`✕ ${errMsg}`, "error");
    }
  }, [lookupFid, loadUserControl, authedPost, addToast]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [debugRes, txnRes] = await Promise.all([
        authedGet("/api/debug-kv"),
        authedGet("/api/txn-log?all=1"),
      ]);
      if (debugRes.error === "Unauthorized" || txnRes.error === "Unauthorized") {
        setError("Wrong secret — check your ?secret= in the URL.");
        setUsers([]); setTxns([]); return;
      }
      setUsers(debugRes.users ?? []);
      setTxns(txnRes.log ?? []);
      setLastLoaded(new Date());
    } catch (err: any) {
      setError(err?.message ?? "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [authedGet]);

  useEffect(() => {
    if (!secret) {
      setError("No secret provided. Open as /admin/dashboard?secret=YOUR_SECRET");
      setLoading(false);
      return;
    }
    load();
  }, [load, secret]);

  // Derived stats
  const usdcTxns = txns.filter((t) => t.amountUsd > 0);
  const totalUsdc = usdcTxns.reduce((s, t) => s + (t.amountUsd || 0), 0);
  const totalDegenPaid = txns.reduce((s, t) => s + (t.amountDegen || 0), 0);
  const usersWithAcc = users.filter((u) => (u.accessoriesUnlockedCount ?? 0) > 0).length;
  const referrers = users.filter((u) => (u.referrals?.referredCount ?? 0) > 0);

  const byType: Record<string, number> = {};
  for (const t of txns) byType[t.type] = (byType[t.type] ?? 0) + 1;

  const sortedTxns = [...txns].sort((a, b) => b.ts - a.ts).slice(0, 40);
  const maxXp = Math.max(1, ...users.map((u) => u.xp || 0));
  const maxCheckins = Math.max(1, ...users.map((u) => u.totalCheckIns || 0));

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* ── Toast stack ── */}
      <div style={{ position: "fixed", bottom: 24, right: 24, zIndex: 1000, display: "flex", flexDirection: "column", gap: 8, pointerEvents: "none" }}>
        {toasts.map((t) => (
          <div key={t.id} style={{
            padding: "10px 16px", borderRadius: 10, fontSize: 13, fontWeight: 600,
            background: t.type === "success" ? C.greenDim : C.redDim,
            border: `1px solid ${t.type === "success" ? C.green + "66" : C.red + "66"}`,
            color: t.type === "success" ? C.green : C.red,
            boxShadow: `0 4px 20px ${t.type === "success" ? C.green : C.red}33`,
            animation: "slideIn 0.2s ease",
            maxWidth: 320,
          }}>
            {t.msg}
          </div>
        ))}
      </div>
      <style>{`@keyframes slideIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`}</style>

      {/* ── Top nav ── */}
      <div style={{
        borderBottom: `1px solid ${T.border}`,
        background: T.surface,
        padding: "0 2rem",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        height: 56,
        position: "sticky",
        top: 0,
        zIndex: 10,
        boxShadow: `0 1px 0 ${C.amberGlow}18`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{
            fontSize: 18,
            fontWeight: 800,
            letterSpacing: "-0.02em",
            background: `linear-gradient(135deg, ${C.amberGlow2}, ${C.amberGlow})`,
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
          }}>🍪 Grub</span>
          <span style={{ fontSize: 11, color: T.textMute, paddingLeft: 12, borderLeft: `1px solid ${T.border}` }}>Admin Console</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {lastLoaded && (
            <span style={{ fontSize: 11, color: T.creamMute }}>
              Last sync {timeAgo(lastLoaded.getTime())}
            </span>
          )}
          {/* Dark / Light toggle */}
          <button
            onClick={() => setDark((d) => !d)}
            title={dark ? "Switch to light mode" : "Switch to dark mode"}
            style={{
              background: T.surfaceAlt,
              border: `1px solid ${T.border}`,
              borderRadius: 8,
              color: T.textSub,
              padding: "7px 12px",
              fontSize: 14,
              cursor: "pointer",
              fontFamily: "inherit",
              lineHeight: 1,
            }}
          >
            {dark ? "☀️" : "🌙"}
          </button>
          <button
            onClick={load}
            disabled={loading}
            style={{
              background: loading ? T.surfaceAlt : C.amberGlow,
              border: "none",
              borderRadius: 8,
              color: loading ? T.textMute : "#0f0900",
              padding: "7px 16px",
              fontSize: 12,
              fontWeight: 700,
              fontFamily: "inherit",
              cursor: loading ? "default" : "pointer",
              letterSpacing: "0.03em",
              boxShadow: loading ? "none" : `0 0 14px ${C.amberGlow}55`,
            }}
          >
            {loading ? "Syncing…" : "↻ Refresh"}
          </button>
        </div>
      </div>

      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem 2rem 4rem" }}>

        {/* Error banner */}
        {error && (
          <div style={{
            margin: "1rem 0",
            padding: "12px 16px",
            borderRadius: 10,
            background: dark ? "#1a0d2e" : "#faf5ff",
            border: `1px solid ${C.amberGlow}55`,
            color: C.amberGlow,
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}>
            <span style={{ fontSize: 16 }}>⚠️</span> {error}
          </div>
        )}

        {/* ── KPI row ── */}
        <SectionLabel>Overview</SectionLabel>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <KpiCard label="Players"        value={String(users.length)}        sub="active pets saved"         accent={C.blue}   dark={dark} />
          <KpiCard label="USDC Revenue"   value={`$${totalUsdc.toFixed(2)}`}  sub={`${usdcTxns.length} purchases`} accent={C.green}  dark={dark} />
          <KpiCard label="DEGEN Paid Out" value={totalDegenPaid.toFixed(0)}   sub="referral rewards"          accent={C.purple} dark={dark} />
          <KpiCard label="Acc. Owners"    value={String(usersWithAcc)}        sub={`of ${users.length} players`}   accent={C.amber}  dark={dark} />
          <KpiCard label="Referrers"      value={String(referrers.length)}    sub="with ≥1 referred user"     accent={C.amberDim} dark={dark} />
        </div>

        {/* ── Charts row ── */}
        <div style={{ display: "grid", gridTemplateColumns: "1.8fr 1fr", gap: 16, marginTop: "1rem" }}>

          {/* Player progress */}
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "1.25rem" }}>
            <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: T.creamMute, margin: "0 0 14px" }}>Player Progress</p>
            {users.length === 0 ? (
              <p style={{ fontSize: 13, color: T.textMute }}>No players yet.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 260, overflowY: "auto" }}>
                {[...users].sort((a, b) => (b.xp || 0) - (a.xp || 0)).map((u) => (
                  <div key={u.fid} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <button
                      onClick={() => { setLookupFid(u.fid); loadUserControl(u.fid); }}
                      style={{ fontSize: 11, color: C.amberGlow, background: "transparent", border: "none", cursor: "pointer", fontFamily: "monospace", width: 72, textAlign: "left", padding: 0, flexShrink: 0, textShadow: `0 0 8px ${C.amberGlow}66` }}
                      title="Open in user panel"
                    >
                      #{u.fid}
                    </button>
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ flex: 1, height: 5, background: T.borderSub, borderRadius: 3, minWidth: 0 }}>
                          <div style={{ height: 5, background: C.blue, borderRadius: 3, width: `${((u.xp || 0) / maxXp) * 100}%`, boxShadow: `0 0 6px ${C.blue}88` }} />
                        </div>
                        <span style={{ fontSize: 10, color: T.textSub, width: 64, textAlign: "right", flexShrink: 0 }}>{(u.xp || 0).toLocaleString()} xp</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ flex: 1, height: 5, background: T.borderSub, borderRadius: 3, minWidth: 0 }}>
                          <div style={{ height: 5, background: C.green, borderRadius: 3, width: `${((u.totalCheckIns || 0) / maxCheckins) * 100}%`, boxShadow: `0 0 6px ${C.green}88` }} />
                        </div>
                        <span style={{ fontSize: 10, color: T.textSub, width: 64, textAlign: "right", flexShrink: 0 }}>{u.totalCheckIns || 0} ci</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Txn type breakdown */}
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "1.25rem" }}>
            <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: T.creamMute, margin: "0 0 14px" }}>Transactions by Type</p>
            {Object.keys(byType).length === 0 ? (
              <p style={{ fontSize: 13, color: T.textMute }}>No transactions yet.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", height: "calc(100% - 30px)", gap: 0 }}>
                {Object.entries(byType).map(([type, count]) => {
                  const meta = TYPE_META[type] ?? { color: T.textSub, bg: T.surfaceAlt, label: type };
                  const pct = Math.round((count / txns.length) * 100);
                  return (
                    <div key={type} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", padding: "10px 0", borderBottom: `1px solid ${T.borderSub}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                        <Badge color={meta.color} bg={meta.bg}>{meta.label}</Badge>
                        <span style={{ fontSize: 13, fontWeight: 700, color: T.cream, fontVariantNumeric: "tabular-nums" }}>{count} <span style={{ fontSize: 11, fontWeight: 400, color: T.textMute }}>({pct}%)</span></span>
                      </div>
                      <div style={{ height: 6, background: T.borderSub, borderRadius: 3 }}>
                        <div style={{ height: 6, background: meta.color, borderRadius: 3, width: `${pct}%`, boxShadow: `0 0 8px ${meta.color}66` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ── Transaction log ── */}
        <SectionLabel>Transaction Log</SectionLabel>
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: `1px solid ${T.borderSub}` }}>
            <span style={{ fontSize: 12, color: T.textMute }}>Showing last {sortedTxns.length} of {txns.length} total</span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: T.surfaceAlt }}>
                  {["Type", "FID", "Detail", "Amount", "When", "Tx"].map((h, i) => (
                    <th key={h} style={{
                      textAlign: i >= 3 ? "right" : "left",
                      padding: "9px 14px",
                      color: T.creamMute,
                      fontWeight: 700,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      fontSize: 10,
                      borderBottom: `1px solid ${T.border}`,
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedTxns.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ padding: "24px 14px", textAlign: "center", color: T.textMute }}>No transactions logged yet.</td>
                  </tr>
                ) : sortedTxns.map((t, i) => {
                  const meta = TYPE_META[t.type] ?? { color: T.textSub, bg: T.surfaceAlt, label: t.type };
                  let detail = "—";
                  let amount = "—";
                  let amountColor = T.textSub;
                  if (t.type === "accessory_unlock") {
                    detail = t.accessoryName || t.accessoryId || "";
                    amount = `$${(t.amountUsd || 0).toFixed(2)}`;
                    amountColor = C.green;
                  } else if (t.type === "referral_join" || t.type === "referral_checkin") {
                    detail = `→ fid ${t.toFid ?? "?"} ${shortAddr(t.toWallet) ? `(${shortAddr(t.toWallet)})` : ""}`;
                    amount = `${t.amountDegen ?? 0} DEGEN`;
                    amountColor = C.amberGlow;
                  } else if (t.amountUsd > 0) {
                    amount = `$${t.amountUsd.toFixed(2)}`;
                    amountColor = C.green;
                  } else if (t.amountDegen) {
                    amount = `${t.amountDegen} DEGEN`;
                    amountColor = C.amberGlow;
                  }
                  return (
                    <tr
                      key={i}
                      style={{
                        borderBottom: `1px solid ${T.borderSub}`,
                        background: i % 2 === 0 ? "transparent" : T.surfaceAlt + "55",
                      }}
                    >
                      <td style={{ padding: "9px 14px" }}>
                        <Badge color={meta.color} bg={meta.bg}>{meta.label}</Badge>
                      </td>
                      <td style={{ padding: "9px 14px", fontFamily: "monospace", color: C.amberGlow, fontSize: 11 }}>{t.fid}</td>
                      <td style={{ padding: "9px 14px", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: T.textSub }} title={detail}>{detail}</td>
                      <td style={{ padding: "9px 14px", textAlign: "right", fontWeight: 600, color: amountColor, fontVariantNumeric: "tabular-nums" }}>{amount}</td>
                      <td style={{ padding: "9px 14px", textAlign: "right", color: T.creamMute }}>{timeAgo(t.ts)}</td>
                      <td style={{ padding: "9px 14px", textAlign: "right" }}>
                        <a href={`https://basescan.org/tx/${t.txHash}`} target="_blank" rel="noopener noreferrer"
                          style={{ color: C.blue, fontSize: 11, fontWeight: 600, textDecoration: "none" }}>
                          ↗ view
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Referral tree ── */}
        <SectionLabel>Referral Tree</SectionLabel>
        {referrers.length === 0 ? (
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "1.25rem" }}><p style={{ fontSize: 13, color: T.textMute, margin: 0 }}>No referrals yet.</p></div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 10 }}>
            {referrers.map((u) => (
              <div key={u.fid} style={{
                background: T.surface,
                border: `1px solid ${T.border}`,
                borderRadius: 10,
                padding: "12px 14px",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <button
                    onClick={() => { setLookupFid(u.fid); loadUserControl(u.fid); }}
                    style={{ fontSize: 13, fontWeight: 700, color: C.amberGlow, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: 0, textShadow: `0 0 10px ${C.amberGlow}66` }}
                  >
                    FID {u.fid}
                  </button>
                  <span style={{ fontSize: 12, fontWeight: 700, color: C.amberGlow2 }}>+{u.referrals?.degenEarned} DEGEN</span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {u.referrals?.referredUsers.map((r) => (
                    <span key={r.fid} style={{
                      fontSize: 11, padding: "3px 9px", borderRadius: 5,
                      background: r.status === "paid" ? C.greenDim : T.surfaceAlt,
                      color: r.status === "paid" ? C.green : T.textSub,
                      border: `1px solid ${r.status === "paid" ? C.green + "66" : T.border}`,
                      whiteSpace: "nowrap",
                    }}>
                      #{r.fid} · {r.checkins}ci
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── User control panel ── */}
        <SectionLabel>Manage User</SectionLabel>
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "1.25rem" }}>
          {/* Lookup */}
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <Input
              value={lookupFid}
              onChange={setLookupFid}
              placeholder="Enter FID"
              onKeyDown={(e) => e.key === "Enter" && loadUserControl(lookupFid)}
            />
            <Btn onClick={() => loadUserControl(lookupFid)} disabled={controlLoading || !lookupFid} variant="amber">
              {controlLoading ? "Loading…" : "Load User"}
            </Btn>
          </div>

          {controlError && (
            <div style={{ padding: "9px 12px", borderRadius: 8, background: C.redDim, border: `1px solid ${C.red}55`, color: C.red, fontSize: 12, marginBottom: 12 }}>
              ✕ {controlError}
            </div>
          )}
          {controlMsg && (
            <div style={{ padding: "9px 12px", borderRadius: 8, background: C.greenDim, border: `1px solid ${C.green}55`, color: C.green, fontSize: 12, marginBottom: 12 }}>
              ✓ {controlMsg}
            </div>
          )}

          {controlState && (
            <div>
              {/* User header */}
              <div style={{
                display: "flex", alignItems: "center", gap: 10, marginBottom: 20,
                padding: "10px 14px", background: T.surfaceAlt, borderRadius: 8,
                border: `1px solid ${T.border}`,
              }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: T.cream, fontFamily: "monospace" }}>FID {controlState.fid}</span>
                <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4,
                  background: controlState.state.banned ? "#3d0000" : C.greenDim,
                  color: controlState.state.banned ? C.red : C.green,
                  fontWeight: 600,
                }}>
                  {controlState.state.banned ? "BANNED" : "Active"}
                </span>
                {controlState.referral?.referredByFid && (
                  <span style={{ fontSize: 11, color: T.textMute }}>sponsored by FID {controlState.referral.referredByFid}</span>
                )}
                <div style={{ marginLeft: "auto", display: "flex", gap: 16 }}>
                  {[
                    ["XP", controlState.state.xp],
                    ["Bond", controlState.state.bond],
                    ["Glimmer", controlState.state.glimmer],
                  ].map(([k, v]) => (
                    <div key={k as string} style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 10, color: T.creamMute, marginBottom: 1 }}>{k}</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: T.cream }}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

                {/* Left col */}
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

                  {/* Adjust stats */}
                  <div style={{ background: T.surfaceAlt, borderRadius: 10, padding: "14px" }}>
                    <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: T.creamMute, margin: "0 0 12px" }}>Adjust Stats</p>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, marginBottom: 12 }}>
                      {(["xp", "bond", "glimmer", "hunger", "happiness"] as const).map((f) => (
                        <NumberInput key={f} label={f} value={statDrafts[f]} onChange={(v) => setStatDrafts((d) => ({ ...d, [f]: v }))} />
                      ))}
                    </div>
                    <Btn onClick={() => runAction("adjust_stats", {
                      xp: Number(statDrafts.xp), bond: Number(statDrafts.bond),
                      glimmer: Number(statDrafts.glimmer), hunger: Number(statDrafts.hunger),
                      happiness: Number(statDrafts.happiness),
                    })} variant="default">Save Stats</Btn>
                  </div>

                  {/* Referral — split into two clearly separate actions */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {/* Set referrer */}
                    <div style={{ background: T.surfaceAlt, borderRadius: 10, padding: "14px", border: `1px solid ${T.border}` }}>
                      <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.amberGlow, margin: "0 0 4px" }}>Set Sponsor</p>
                      <p style={{ fontSize: 11, color: T.textMute, margin: "0 0 10px" }}>Replaces their current sponsor — no need to remove first.</p>
                      <div style={{ display: "flex", gap: 8 }}>
                        <Input value={newReferrerFid} onChange={setNewReferrerFid} placeholder="Sponsor FID" />
                        <Btn onClick={() => runAction("edit_referral", { newReferrerFid })} disabled={!newReferrerFid} variant="amber">Set</Btn>
                      </div>
                    </div>

                    {/* Remove referral */}
                    <div style={{ background: C.redDim, borderRadius: 10, padding: "14px", border: `1px solid ${C.red}44` }}>
                      <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.red, margin: "0 0 4px" }}>Remove Sponsor</p>
                      <p style={{ fontSize: 11, color: T.textMute, margin: "0 0 10px" }}>Removes the user who sponsored this player (referredBy).</p>
                      <Btn onClick={() => runAction("edit_referral", { removeReferral: true })} variant="red">✕ Remove Sponsor</Btn>
                    </div>
                  </div>

                  {/* Ban */}
                  <div style={{ background: T.surfaceAlt, borderRadius: 10, padding: "14px" }}>
                    <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: T.creamMute, margin: "0 0 6px" }}>Account Status</p>
                    <p style={{ fontSize: 11, color: T.textMute, margin: "0 0 10px" }}>Banning blocks feeding, unlocking, and check-ins.</p>
                    <Btn
                      onClick={() => runAction(controlState.state.banned ? "unban" : "ban")}
                      variant={controlState.state.banned ? "green" : "red"}
                    >
                      {controlState.state.banned ? "✓ Unban User" : "✕ Ban User"}
                    </Btn>
                  </div>
                </div>

                {/* Right col — Accessories */}
                <div style={{ background: T.surfaceAlt, borderRadius: 10, padding: "14px" }}>
                  <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: T.creamMute, margin: "0 0 12px" }}>
                    Accessories — {controlState.state.accessoriesUnlocked.length} unlocked
                  </p>

                  {/* Current accessories */}
                  <div style={{ minHeight: 48, marginBottom: 14 }}>
                    {controlState.state.accessoriesUnlocked.length === 0 ? (
                      <p style={{ fontSize: 12, color: T.textMute }}>None unlocked yet.</p>
                    ) : (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {controlState.state.accessoriesUnlocked.map((id: string) => (
                          <span key={id} style={{
                            fontSize: 11, padding: "4px 10px", borderRadius: 6,
                            background: T.bg, border: `1px solid ${C.amberGlow}55`,
                            color: C.amberGlow, fontWeight: 500,
                          }}>
                            {id}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {/* Grant */}
                    <div>
                      <p style={{ fontSize: 10, fontWeight: 600, color: C.green, margin: "0 0 6px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Grant Accessory</p>
                      <div style={{ display: "flex", gap: 8 }}>
                        <Input value={accessoryToUnlock} onChange={setAccessoryToUnlock} placeholder="accessory id" />
                        <Btn onClick={() => { runAction("unlock_accessory", { accessoryId: accessoryToUnlock }); setAccessoryToUnlock(""); }}
                          disabled={!accessoryToUnlock} variant="green">
                          Unlock
                        </Btn>
                      </div>
                    </div>

                    {/* Revoke */}
                    <div>
                      <p style={{ fontSize: 10, fontWeight: 600, color: C.red, margin: "0 0 6px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Revoke Accessory</p>
                      <div style={{ display: "flex", gap: 8 }}>
                        <Input value={accessoryToRevoke} onChange={setAccessoryToRevoke} placeholder="accessory id" />
                        <Btn onClick={() => { runAction("revoke_accessory", { accessoryId: accessoryToRevoke }); setAccessoryToRevoke(""); }}
                          disabled={!accessoryToRevoke} variant="red">
                          Revoke
                        </Btn>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AdminDashboardPage() {
  return (
    <Suspense fallback={
      <div style={{ minHeight: "100vh", background: "#0f0e0c", color: "#d4920a", fontFamily: "system-ui, sans-serif", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>
        Loading Grub console…
      </div>
    }>
      <AdminDashboardInner />
    </Suspense>
  );
}
