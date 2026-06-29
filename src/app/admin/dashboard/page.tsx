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
  bg:        "#0f0e0c",
  surface:   "#18160f",
  surfaceAlt:"#1e1b12",
  border:    "#2e2b1f",
  borderSub: "#252218",
  amber:     "#d4920a",
  amberDim:  "#a06e06",
  amberGlow: "#f5a623",
  cream:     "#f0e6c8",
  creamDim:  "#b8ad94",
  creamMute: "#7a7264",
  green:     "#22c97a",
  greenDim:  "#145c37",
  blue:      "#4a90d9",
  blueDim:   "#1b3d63",
  purple:    "#8b6fd6",
  red:       "#e05252",
  redDim:    "#5a1e1e",
  text:      "#ede7d2",
  textSub:   "#a09880",
  textMute:  "#5e5a4e",
};

const TYPE_META: Record<string, { color: string; bg: string; label: string }> = {
  accessory_unlock: { color: C.blue,   bg: C.blueDim,  label: "Accessory" },
  checkin:          { color: C.green,  bg: C.greenDim, label: "Check-in"  },
  referral_join:    { color: C.amber,  bg: "#3d2c05",  label: "Ref Join"  },
  referral_checkin: { color: C.purple, bg: "#2e1f5e",  label: "Ref Check" },
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

function KpiCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div style={{
      background: C.surface,
      border: `1px solid ${C.border}`,
      borderRadius: 12,
      padding: "1.25rem 1.5rem",
      flex: 1,
      minWidth: 160,
      position: "relative",
      overflow: "hidden",
    }}>
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 2,
        background: accent ?? C.amber,
        borderRadius: "12px 12px 0 0",
      }} />
      <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: C.creamMute, margin: "0 0 8px" }}>{label}</p>
      <p style={{ fontSize: 28, fontWeight: 700, margin: 0, color: C.cream, lineHeight: 1 }}>{value}</p>
      {sub && <p style={{ fontSize: 12, color: C.textMute, margin: "6px 0 0" }}>{sub}</p>}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "2rem 0 0.75rem" }}>
      <span style={{ width: 3, height: 14, background: C.amber, borderRadius: 2, display: "block", flexShrink: 0 }} />
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
    default: { border: `1px solid ${C.border}`,   color: C.creamDim, bg: "transparent" },
    green:   { border: `1px solid ${C.green}`,    color: C.green,    bg: C.greenDim   },
    amber:   { border: `1px solid ${C.amber}`,    color: C.amberGlow,bg: "#2e1f00"    },
    red:     { border: `1px solid ${C.red}`,      color: C.red,      bg: C.redDim     },
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
        fontWeight: 600,
        fontFamily: "inherit",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.45 : 1,
        whiteSpace: "nowrap",
        letterSpacing: "0.02em",
        transition: "opacity 0.15s",
      }}
    >{children}</button>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "1.25rem" }}>
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
        setControlError(res.reason ?? "Action failed");
      } else {
        setControlMsg(res.warning ? `Done — note: ${res.warning}` : `${action.replace(/_/g, " ")} applied.`);
        loadUserControl(lookupFid);
      }
    } catch (err: any) {
      setControlError(err?.message ?? "Action failed");
    }
  }, [lookupFid, loadUserControl, authedPost]);

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
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* ── Top nav ── */}
      <div style={{
        borderBottom: `1px solid ${C.border}`,
        background: C.surface,
        padding: "0 2rem",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        height: 56,
        position: "sticky",
        top: 0,
        zIndex: 10,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{
            fontSize: 18,
            fontWeight: 800,
            letterSpacing: "-0.02em",
            background: `linear-gradient(135deg, ${C.amberGlow}, ${C.amber})`,
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
          }}>🍪 Grub</span>
          <span style={{ fontSize: 11, color: C.textMute, paddingLeft: 12, borderLeft: `1px solid ${C.border}` }}>Admin Console</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {lastLoaded && (
            <span style={{ fontSize: 11, color: C.textMute }}>
              Last sync {timeAgo(lastLoaded.getTime())}
            </span>
          )}
          <button
            onClick={load}
            disabled={loading}
            style={{
              background: loading ? C.surfaceAlt : `linear-gradient(135deg, ${C.amberDim}, ${C.amber})`,
              border: "none",
              borderRadius: 8,
              color: loading ? C.textMute : "#0f0e0c",
              padding: "7px 16px",
              fontSize: 12,
              fontWeight: 700,
              fontFamily: "inherit",
              cursor: loading ? "default" : "pointer",
              letterSpacing: "0.02em",
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
            background: "#2a1200",
            border: `1px solid ${C.amberDim}`,
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
          <KpiCard label="Players"        value={String(users.length)}        sub="active pets saved"         accent={C.blue}   />
          <KpiCard label="USDC Revenue"   value={`$${totalUsdc.toFixed(2)}`}  sub={`${usdcTxns.length} purchases`} accent={C.green}  />
          <KpiCard label="DEGEN Paid Out" value={totalDegenPaid.toFixed(0)}   sub="referral rewards"          accent={C.purple} />
          <KpiCard label="Acc. Owners"    value={String(usersWithAcc)}        sub={`of ${users.length} players`}   accent={C.amber}  />
          <KpiCard label="Referrers"      value={String(referrers.length)}    sub="with ≥1 referred user"     accent={C.amberDim} />
        </div>

        {/* ── Charts row ── */}
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16, marginTop: "1rem" }}>

          {/* Player progress */}
          <Panel>
            <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.creamMute, margin: "0 0 14px" }}>Player Progress</p>
            {users.length === 0 ? (
              <p style={{ fontSize: 13, color: C.textMute }}>No players yet.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 260, overflowY: "auto" }}>
                {[...users].sort((a, b) => (b.xp || 0) - (a.xp || 0)).map((u) => (
                  <div key={u.fid} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <button
                      onClick={() => { setLookupFid(u.fid); loadUserControl(u.fid); }}
                      style={{ fontSize: 11, color: C.amber, background: "transparent", border: "none", cursor: "pointer", fontFamily: "monospace", width: 60, textAlign: "left", padding: 0, flexShrink: 0 }}
                      title="Open in user panel"
                    >
                      #{u.fid}
                    </button>
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <div style={{ flex: 1, height: 5, background: C.borderSub, borderRadius: 3 }}>
                          <div style={{ height: 5, background: C.blue, borderRadius: 3, width: `${((u.xp || 0) / maxXp) * 100}%` }} />
                        </div>
                        <span style={{ fontSize: 10, color: C.textMute, width: 48, textAlign: "right" }}>{u.xp || 0} xp</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <div style={{ flex: 1, height: 5, background: C.borderSub, borderRadius: 3 }}>
                          <div style={{ height: 5, background: C.green, borderRadius: 3, width: `${((u.totalCheckIns || 0) / maxCheckins) * 100}%` }} />
                        </div>
                        <span style={{ fontSize: 10, color: C.textMute, width: 48, textAlign: "right" }}>{u.totalCheckIns || 0} ci</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {/* Txn type breakdown */}
          <Panel>
            <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.creamMute, margin: "0 0 14px" }}>Transactions by Type</p>
            {Object.keys(byType).length === 0 ? (
              <p style={{ fontSize: 13, color: C.textMute }}>No transactions yet.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {Object.entries(byType).map(([type, count]) => {
                  const meta = TYPE_META[type] ?? { color: C.textSub, bg: C.surfaceAlt, label: type };
                  const pct = Math.round((count / txns.length) * 100);
                  return (
                    <div key={type}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                        <Badge color={meta.color} bg={meta.bg}>{meta.label}</Badge>
                        <span style={{ fontSize: 12, color: C.creamDim, fontVariantNumeric: "tabular-nums" }}>{count} <span style={{ color: C.textMute }}>({pct}%)</span></span>
                      </div>
                      <div style={{ height: 4, background: C.borderSub, borderRadius: 2 }}>
                        <div style={{ height: 4, background: meta.color, borderRadius: 2, width: `${pct}%`, opacity: 0.8 }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>
        </div>

        {/* ── Transaction log ── */}
        <SectionLabel>Transaction Log</SectionLabel>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: `1px solid ${C.borderSub}` }}>
            <span style={{ fontSize: 12, color: C.textMute }}>Showing last {sortedTxns.length} of {txns.length} total</span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: C.surfaceAlt }}>
                  {["Type", "FID", "Detail", "Amount", "When", "Tx"].map((h, i) => (
                    <th key={h} style={{
                      textAlign: i >= 3 ? "right" : "left",
                      padding: "9px 14px",
                      color: C.textMute,
                      fontWeight: 600,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      fontSize: 10,
                      borderBottom: `1px solid ${C.border}`,
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedTxns.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ padding: "24px 14px", textAlign: "center", color: C.textMute }}>No transactions logged yet.</td>
                  </tr>
                ) : sortedTxns.map((t, i) => {
                  const meta = TYPE_META[t.type] ?? { color: C.textSub, bg: C.surfaceAlt, label: t.type };
                  let detail = "—";
                  let amount = "—";
                  let amountColor = C.textSub;
                  if (t.type === "accessory_unlock") {
                    detail = t.accessoryName || t.accessoryId || "";
                    amount = `$${(t.amountUsd || 0).toFixed(2)}`;
                    amountColor = C.green;
                  } else if (t.type === "referral_join" || t.type === "referral_checkin") {
                    detail = `→ fid ${t.toFid ?? "?"} ${shortAddr(t.toWallet) ? `(${shortAddr(t.toWallet)})` : ""}`;
                    amount = `${t.amountDegen ?? 0} DEGEN`;
                    amountColor = C.amber;
                  } else if (t.amountUsd > 0) {
                    amount = `$${t.amountUsd.toFixed(2)}`;
                    amountColor = C.green;
                  } else if (t.amountDegen) {
                    amount = `${t.amountDegen} DEGEN`;
                    amountColor = C.amber;
                  }
                  return (
                    <tr
                      key={i}
                      style={{
                        borderBottom: `1px solid ${C.borderSub}`,
                        background: i % 2 === 0 ? "transparent" : C.surfaceAlt + "55",
                      }}
                    >
                      <td style={{ padding: "9px 14px" }}>
                        <Badge color={meta.color} bg={meta.bg}>{meta.label}</Badge>
                      </td>
                      <td style={{ padding: "9px 14px", fontFamily: "monospace", color: C.amber, fontSize: 11 }}>{t.fid}</td>
                      <td style={{ padding: "9px 14px", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: C.textSub }} title={detail}>{detail}</td>
                      <td style={{ padding: "9px 14px", textAlign: "right", fontWeight: 600, color: amountColor, fontVariantNumeric: "tabular-nums" }}>{amount}</td>
                      <td style={{ padding: "9px 14px", textAlign: "right", color: C.textMute }}>{timeAgo(t.ts)}</td>
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
          <Panel><p style={{ fontSize: 13, color: C.textMute, margin: 0 }}>No referrals yet.</p></Panel>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
            {referrers.map((u) => (
              <div key={u.fid} style={{
                background: C.surface,
                border: `1px solid ${C.border}`,
                borderRadius: 10,
                padding: "12px 14px",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <button
                    onClick={() => { setLookupFid(u.fid); loadUserControl(u.fid); }}
                    style={{ fontSize: 13, fontWeight: 700, color: C.amber, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: 0 }}
                  >
                    FID {u.fid}
                  </button>
                  <span style={{ fontSize: 12, fontWeight: 700, color: C.amberGlow }}>+{u.referrals?.degenEarned} DEGEN</span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {u.referrals?.referredUsers.map((r) => (
                    <span key={r.fid} style={{
                      fontSize: 10, padding: "2px 7px", borderRadius: 4,
                      background: r.status === "paid" ? C.greenDim : C.surfaceAlt,
                      color: r.status === "paid" ? C.green : C.textMute,
                      border: `1px solid ${r.status === "paid" ? C.green + "55" : C.border}`,
                    }}>
                      #{r.fid} · {r.checkins} ci
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── User control panel ── */}
        <SectionLabel>Manage User</SectionLabel>
        <Panel>
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
                padding: "10px 14px", background: C.surfaceAlt, borderRadius: 8,
                border: `1px solid ${C.border}`,
              }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: C.cream, fontFamily: "monospace" }}>FID {controlState.fid}</span>
                <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4,
                  background: controlState.state.banned ? "#3d0000" : C.greenDim,
                  color: controlState.state.banned ? C.red : C.green,
                  fontWeight: 600,
                }}>
                  {controlState.state.banned ? "BANNED" : "Active"}
                </span>
                {controlState.referral?.referredByFid && (
                  <span style={{ fontSize: 11, color: C.textMute }}>referred by FID {controlState.referral.referredByFid}</span>
                )}
                <div style={{ marginLeft: "auto", display: "flex", gap: 16 }}>
                  {[
                    ["XP", controlState.state.xp],
                    ["Bond", controlState.state.bond],
                    ["Glimmer", controlState.state.glimmer],
                  ].map(([k, v]) => (
                    <div key={k as string} style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 10, color: C.textMute, marginBottom: 1 }}>{k}</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: C.cream }}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

                {/* Left col */}
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

                  {/* Adjust stats */}
                  <div style={{ background: C.surfaceAlt, borderRadius: 10, padding: "14px" }}>
                    <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.creamMute, margin: "0 0 12px" }}>Adjust Stats</p>
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

                  {/* Referral */}
                  <div style={{ background: C.surfaceAlt, borderRadius: 10, padding: "14px" }}>
                    <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.creamMute, margin: "0 0 12px" }}>Referral Relationship</p>
                    <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                      <Input value={newReferrerFid} onChange={setNewReferrerFid} placeholder="New referrer FID" />
                      <Btn onClick={() => runAction("edit_referral", { newReferrerFid })} disabled={!newReferrerFid}>Set</Btn>
                    </div>
                    <Btn onClick={() => runAction("edit_referral", { removeReferral: true })} variant="red">Remove Referral</Btn>
                  </div>

                  {/* Ban */}
                  <div style={{ background: C.surfaceAlt, borderRadius: 10, padding: "14px" }}>
                    <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.creamMute, margin: "0 0 6px" }}>Account Status</p>
                    <p style={{ fontSize: 11, color: C.textMute, margin: "0 0 10px" }}>Banning blocks feeding, unlocking, and check-ins.</p>
                    <Btn
                      onClick={() => runAction(controlState.state.banned ? "unban" : "ban")}
                      variant={controlState.state.banned ? "green" : "red"}
                    >
                      {controlState.state.banned ? "✓ Unban User" : "✕ Ban User"}
                    </Btn>
                  </div>
                </div>

                {/* Right col — Accessories */}
                <div style={{ background: C.surfaceAlt, borderRadius: 10, padding: "14px" }}>
                  <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.creamMute, margin: "0 0 12px" }}>
                    Accessories — {controlState.state.accessoriesUnlocked.length} unlocked
                  </p>

                  {/* Current accessories */}
                  <div style={{ minHeight: 48, marginBottom: 14 }}>
                    {controlState.state.accessoriesUnlocked.length === 0 ? (
                      <p style={{ fontSize: 12, color: C.textMute }}>None unlocked yet.</p>
                    ) : (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {controlState.state.accessoriesUnlocked.map((id: string) => (
                          <span key={id} style={{
                            fontSize: 11, padding: "4px 10px", borderRadius: 6,
                            background: C.bg, border: `1px solid ${C.amber}55`,
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
        </Panel>
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
