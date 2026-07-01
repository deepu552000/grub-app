// app/admin/dashboard/page.tsx
// Protected by Clerk — only signed-in users can reach this page

"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useAuth, useClerk } from "@clerk/nextjs";

type DebugUser = {
  fid: string;
  xp: number;
  totalCheckIns: number;
  accessoriesUnlockedCount: number;
  accessoriesUnlocked: string[];
  hasNotifToken?: boolean;
  hasAddedApp?: boolean;
  noPetState?: boolean;
  lastVisit: string;
  lastCheckInDay?: string;
  referrals?: {
    referredBy: number | null;
    referredCount: number;
    referredUsers: { fid: number; checkins: number; status: string }[];
    degenEarned: number;
  };
};

type WebhookLogEntry = {
  ts: number;
  appFid: number;
  fid: number;
  event: string;
  payload: any;
};

type FailedPayout = {
  id: string;
  fid: number;
  toFid: number;
  toWallet: string;
  amountDegen: number;
  type: "referral_join" | "referral_checkin";
  reason: string;
  ts: number;
  sideEffect?: { kvKey: string; kvValue: any } | null;
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

function NotifPill({ on, dark = true }: { on?: boolean; dark?: boolean }) {
  const onColor = C.green;
  const offColor = dark ? "#6b7280" : "#9ca3af";
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: "0.04em",
      padding: "2px 7px",
      borderRadius: 10,
      flexShrink: 0,
      color: on ? onColor : offColor,
      background: on ? `${onColor}1a` : (dark ? "#ffffff0d" : "#0000000d"),
      border: `1px solid ${on ? onColor + "55" : offColor + "55"}`,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: on ? onColor : offColor, boxShadow: on ? `0 0 5px ${onColor}` : "none" }} />
      {on ? "ON" : "OFF"}
    </span>
  );
}

function SectionLabel({ children, accent, dark = true }: { children: React.ReactNode; accent?: string; dark?: boolean }) {
  const barColor = accent ?? C.amberGlow;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "2rem 0 0.75rem" }}>
      <span style={{ width: 3, height: 14, background: barColor, borderRadius: 2, display: "block", flexShrink: 0, boxShadow: `0 0 8px ${barColor}` }} />
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: dark ? C.creamDim : "#374151" }}>{children}</span>
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

function Input({ value, onChange, placeholder, onKeyDown, style }: {
  value: string; onChange: (v: string) => void; placeholder?: string; onKeyDown?: React.KeyboardEventHandler; style?: React.CSSProperties;
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
        ...style,
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
  const { getToken } = useAuth();
  const { signOut } = useClerk();

  const [users, setUsers] = useState<DebugUser[]>([]);
  const [txns, setTxns] = useState<TxnEntry[]>([]);
  const [webhookEvents, setWebhookEvents] = useState<WebhookLogEntry[]>([]);
  const [profiles, setProfiles] = useState<Record<string, { username: string | null; displayName: string | null }>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastLoaded, setLastLoaded] = useState<Date | null>(null);
  const [dark, setDark] = useState(true);
  const [failedPayouts, setFailedPayouts] = useState<FailedPayout[]>([]);
  const [poolDegen, setPoolDegen] = useState<number | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [playerSearchQuery, setPlayerSearchQuery] = useState("");
  const [globalSearchQuery, setGlobalSearchQuery] = useState("");

  // Result modal (replaces toast)
  const [modal, setModal] = useState<{ msg: string; type: "success" | "error" } | null>(null);
  const showModal = useCallback((msg: string, type: "success" | "error" = "success") => {
    setModal({ msg, type });
  }, []);
  // keep addToast name so runAction callers don't need changing
  const addToast = showModal;

  // Light theme overrides — Claude's actual palette
  const T = dark ? {
    bg: C.bg, surface: C.surface, surfaceAlt: C.surfaceAlt, border: C.border, borderSub: C.borderSub,
    text: C.text, textSub: C.textSub, textMute: C.textMute, cream: C.cream, creamDim: C.creamDim, creamMute: C.creamMute,
    accent: C.amberGlow,
  } : {
    bg: "#f9f9f8",
    surface: "#ffffff",
    surfaceAlt: "#f3f3f0",
    border: "#e5e5e2",
    borderSub: "#ededed",
    text: "#1a1a18",
    textSub: "#4a4a45",
    textMute: "#8a8a85",
    cream: "#1a1a18",
    creamDim: "#2d2d2a",
    creamMute: "#6a6a65",
    accent: "#d97706",
  };

  const [lookupFid, setLookupFid] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const [controlState, setControlState] = useState<any>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [controlLoading, setControlLoading] = useState(false);
  const [controlMsg, setControlMsg] = useState<string | null>(null);
  const [statDrafts, setStatDrafts] = useState({ xp: "", bond: "", glimmer: "", hunger: "", happiness: "" });
  const [accessoryToRevoke, setAccessoryToRevoke] = useState("");
  const [accessoryToUnlock, setAccessoryToUnlock] = useState("");
  const [newReferrerFid, setNewReferrerFid] = useState("");

  const authedGet = useCallback(async (path: string) => {
    const token = await getToken();
    return fetch(path, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
  }, [getToken]);

  const authedPost = useCallback(async (path: string, body: Record<string, any>) => {
    const token = await getToken();
    return fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  }, [getToken]);

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

  const resolveFailedPayout = useCallback(async (id: string, action: "retry" | "dismiss") => {
    setRetryingId(id);
    try {
      const res = await authedPost("/api/admin/failed-payouts", { id, action });
      if (res.ok) {
        setFailedPayouts((prev) => prev.filter((p) => p.id !== id));
        addToast(action === "retry" ? `✓ Payout sent (${res.txHash?.slice(0, 10)}…)` : "✓ Dismissed", "success");
      } else {
        addToast(`✕ ${res.detail ?? res.reason ?? "Retry failed"}`, "error");
        if (action === "retry") {
          // still failing — refresh the reason/timestamp shown for this record
          setFailedPayouts((prev) =>
            prev.map((p) => (p.id === id ? { ...p, reason: res.detail ?? p.reason, ts: Date.now() } : p))
          );
        }
      }
    } catch (err: any) {
      addToast(`✕ ${err?.message ?? "Retry failed"}`, "error");
    } finally {
      setRetryingId(null);
    }
  }, [authedPost, addToast]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // Clear the manage-user panel so it's visibly fresh after refresh
    setControlState(null);
    setControlError(null);
    setControlMsg(null);
    setLookupFid("");
    setStatDrafts({ xp: "", bond: "", glimmer: "", hunger: "", happiness: "" });
    try {
      const [debugRes, txnRes, failedRes] = await Promise.all([
        authedGet("/api/debug-kv"),
        authedGet("/api/txn-log?all=1"),
        authedGet("/api/admin/failed-payouts"),
      ]);
      if (debugRes.error === "Unauthorized" || txnRes.error === "Unauthorized") {
        setError("Unauthorized — you may not have access to this dashboard.");
        setUsers([]); setTxns([]); return;
      }
      setUsers(debugRes.users ?? []);
      setWebhookEvents(debugRes.webhookEvents ?? []);
      setTxns(txnRes.log ?? []);
      setFailedPayouts(failedRes?.payouts ?? []);
      setLastLoaded(new Date());
      // Treasury balance — non-blocking, don't let a pool-check hiccup break the main load
      fetch("/api/referral/pool")
        .then((r) => r.json())
        .then((p) => setPoolDegen(typeof p?.poolDegen === "number" ? p.poolDegen : null))
        .catch(() => setPoolDegen(null));
    } catch (err: any) {
      setError(err?.message ?? "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [authedGet]);

  useEffect(() => {
    load();
  }, [load]);

  // Resolve FID -> Farcaster username/displayName once users are loaded.
  // Only fetches fids we don't already have cached.
  useEffect(() => {
    if (users.length === 0) return;
    const fidsToResolve = users
      .map((u) => u.fid)
      .filter((fid) => !(fid in profiles));
    if (fidsToResolve.length === 0) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await authedPost("/api/admin/resolve-fids", { fids: fidsToResolve });
        if (cancelled || !res?.users) return;
        setProfiles((prev) => {
          const next = { ...prev };
          for (const u of res.users) {
            next[String(u.fid)] = { username: u.username, displayName: u.displayName };
          }
          // mark any fid we asked for but got nothing back so we don't retry forever
          for (const fid of fidsToResolve) {
            if (!(fid in next)) next[fid] = { username: null, displayName: null };
          }
          return next;
        });
      } catch (err) {
        console.error("Failed to resolve fid usernames:", err);
      }
    })();

    return () => { cancelled = true; };
  }, [users, profiles, authedPost]);

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
  const realUsers = users.filter((u) => (u.xp || 0) > 0 || (u.totalCheckIns || 0) > 0);
  const ghostUsers = users.filter((u) => !((u.xp || 0) > 0 || (u.totalCheckIns || 0) > 0));

  // Global dashboard-wide search (fid or username) — combines with each panel's own search below
  const globalMatchesFid = useCallback((fid: number | string) => {
    const q = globalSearchQuery.trim().toLowerCase();
    if (!q) return true;
    const profile = profiles[String(fid)];
    return (
      String(fid).toLowerCase().includes(q) ||
      (profile?.username ?? "").toLowerCase().includes(q) ||
      (profile?.displayName ?? "").toLowerCase().includes(q)
    );
  }, [globalSearchQuery, profiles]);

  // Player Progress panel search — must satisfy its own box AND the global box
  const playerMatchesSearch = useCallback((u: DebugUser) => {
    const q = playerSearchQuery.trim().toLowerCase();
    if (q) {
      // Local box has text — it takes precedence, global is ignored for this panel
      const profile = profiles[String(u.fid)];
      return (
        String(u.fid).toLowerCase().includes(q) ||
        (profile?.username ?? "").toLowerCase().includes(q) ||
        (profile?.displayName ?? "").toLowerCase().includes(q)
      );
    }
    // Local box empty — fall back to global search
    return globalMatchesFid(u.fid);
  }, [playerSearchQuery, profiles, globalMatchesFid]);

  const filteredRealUsers = realUsers.filter(playerMatchesSearch);
  const filteredGhostUsers = ghostUsers.filter(playerMatchesSearch);

  const filteredSortedTxns = sortedTxns.filter((t) => globalMatchesFid(t.fid) || globalMatchesFid(t.toFid ?? ""));
  const filteredWebhookEvents = webhookEvents.filter((e) => globalMatchesFid(e.fid));
  const filteredReferrers = referrers.filter((u) => globalMatchesFid(u.fid));
  const notifStatusUsers = [...users].sort((a, b) => {
    // Flag cases first (added but no token), then by check-ins desc
    const aFlag = a.hasAddedApp && !a.hasNotifToken ? 1 : 0;
    const bFlag = b.hasAddedApp && !b.hasNotifToken ? 1 : 0;
    if (aFlag !== bFlag) return bFlag - aFlag;
    return (b.totalCheckIns || 0) - (a.totalCheckIns || 0);
  });
  const addedButNotifOffCount = users.filter((u) => u.hasAddedApp && !u.hasNotifToken).length;

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* ── Result Modal ── */}
      {modal && (
        <div
          onClick={() => setModal(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 2000,
            background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: T.surface,
              border: `1px solid ${modal.type === "success" ? C.green + "66" : C.red + "66"}`,
              borderRadius: 14,
              padding: "28px 32px",
              maxWidth: 380,
              width: "90vw",
              boxShadow: `0 8px 40px rgba(0,0,0,0.35), 0 0 0 1px ${modal.type === "success" ? C.green : C.red}22`,
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 36, marginBottom: 12 }}>{modal.type === "success" ? "✅" : "❌"}</div>
            <p style={{ fontSize: 14, fontWeight: 600, color: T.cream, margin: "0 0 20px", lineHeight: 1.5 }}>{modal.msg}</p>
            <button
              onClick={() => setModal(null)}
              style={{
                background: modal.type === "success" ? C.green : C.red,
                border: "none", borderRadius: 8,
                color: modal.type === "success" ? "#001a0d" : "#fff",
                padding: "9px 28px", fontSize: 13, fontWeight: 700,
                cursor: "pointer", fontFamily: "inherit",
              }}
            >
              OK
            </button>
          </div>
        </div>
      )}
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
          <span style={{ display: "inline-block", fontSize: 18, fontWeight: 800, letterSpacing: "-0.02em", color: dark ? C.amberGlow : "#d97706" }}>
            🍪 Grub
          </span>
          <span style={{ fontSize: 11, color: T.textMute, paddingLeft: 12, borderLeft: `1px solid ${T.border}` }}>Admin Console</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* Global dashboard search */}
          <div style={{ position: "relative", width: 200 }}>
            <input
              value={globalSearchQuery}
              onChange={(e) => setGlobalSearchQuery(e.target.value)}
              placeholder="🔍 Search FID / @user…"
              title="Filters Transaction Log, Webhook Log & Referral Tree"
              style={{
                width: "100%",
                fontSize: 12,
                padding: "6px 26px 6px 10px",
                borderRadius: 8,
                background: T.surfaceAlt,
                border: `1px solid ${T.border}`,
                color: T.cream,
                outline: "none",
                boxSizing: "border-box",
              }}
            />
            {globalSearchQuery && (
              <button
                onClick={() => setGlobalSearchQuery("")}
                style={{
                  position: "absolute", right: 7, top: "50%", transform: "translateY(-50%)",
                  background: "transparent", border: "none", cursor: "pointer",
                  color: T.textMute, fontSize: 12, lineHeight: 1, padding: 2,
                }}
                title="Clear search"
              >
                ✕
              </button>
            )}
          </div>
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
              background: loading ? T.surfaceAlt : (dark ? C.amberGlow : "#d97706"),
              border: "none",
              borderRadius: 8,
              color: loading ? T.textMute : (dark ? "#0f0900" : "#fff"),
              padding: "7px 16px",
              fontSize: 12,
              fontWeight: 700,
              fontFamily: "inherit",
              cursor: loading ? "default" : "pointer",
              letterSpacing: "0.03em",
              boxShadow: loading ? "none" : `0 0 14px ${dark ? C.amberGlow : "#d97706"}55`,
            }}
          >
            {loading ? "Syncing…" : "↻ Refresh"}
          </button>
          <button
            onClick={() => signOut({ redirectUrl: "/admin" })}
            style={{
              background: C.redDim,
              border: `1px solid ${C.red}55`,
              borderRadius: 8,
              color: C.red,
              padding: "7px 16px",
              fontSize: 12,
              fontWeight: 700,
              fontFamily: "inherit",
              cursor: "pointer",
              letterSpacing: "0.03em",
            }}
          >
            Sign Out
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

        {/* ── Treasury balance + failed payouts alert ── */}
        {poolDegen !== null && (
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 10,
            padding: "6px 12px", borderRadius: 999, fontSize: 12, fontWeight: 600,
            background: poolDegen < 20 ? C.redDim : (dark ? T.surfaceAlt : "#eef2ff"),
            color: poolDegen < 20 ? C.red : T.textSub,
            border: `1px solid ${poolDegen < 20 ? C.red + "55" : T.border}`,
          }}>
            💰 Treasury: {poolDegen.toLocaleString(undefined, { maximumFractionDigits: 2 })} DEGEN
            {poolDegen < 20 && " — low, refill soon"}
          </div>
        )}

        {failedPayouts.length > 0 && (
          <div style={{
            background: C.redDim, border: `1px solid ${C.red}55`, borderRadius: 12,
            padding: "14px 16px", marginBottom: "1rem",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 16 }}>⚠️</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: C.red }}>
                {failedPayouts.length} DEGEN payout{failedPayouts.length > 1 ? "s" : ""} failed to send
              </span>
              <span style={{ fontSize: 11, color: T.textMute }}>— likely treasury ran out of DEGEN. Refill, then retry below.</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {failedPayouts.map((p) => (
                <div key={p.id} style={{
                  display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                  padding: "8px 10px", borderRadius: 8, background: dark ? "#1a0a0a" : "#fff5f5",
                  fontSize: 12,
                }}>
                  <span style={{ fontFamily: "monospace", color: T.cream, fontWeight: 600 }}>
                    {p.amountDegen} DEGEN → fid {p.fid}
                  </span>
                  <span style={{ color: T.textMute }}>({p.type.replace("_", " ")}, triggered by fid {p.toFid})</span>
                  <span style={{ color: C.red, fontStyle: "italic" }}>{p.reason}</span>
                  <span style={{ color: T.textMute, marginLeft: "auto" }}>{timeAgo(p.ts)}</span>
                  <Btn onClick={() => resolveFailedPayout(p.id, "retry")} disabled={retryingId === p.id} variant="green">
                    {retryingId === p.id ? "Retrying…" : "↻ Retry"}
                  </Btn>
                  <Btn onClick={() => resolveFailedPayout(p.id, "dismiss")} disabled={retryingId === p.id} variant="red">
                    Dismiss
                  </Btn>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── KPI row ── */}
        <SectionLabel dark={dark}>Overview</SectionLabel>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <KpiCard label="Players"        value={String(users.length)}        sub="active pets saved"         accent={C.blue}   dark={dark} />
          <KpiCard label="Real Players"   value={String(realUsers.length)}    sub={`${ghostUsers.length} unconverted opens`} accent={C.green}  dark={dark} />
          <KpiCard label="USDC Revenue"   value={`$${totalUsdc.toFixed(2)}`}  sub={`${usdcTxns.length} purchases`} accent={C.green}  dark={dark} />
          <KpiCard label="DEGEN Paid Out" value={totalDegenPaid.toFixed(0)}   sub="referral rewards"          accent={C.purple} dark={dark} />
          <KpiCard label="Acc. Owners"    value={String(usersWithAcc)}        sub={`of ${users.length} players`}   accent={C.amber}  dark={dark} />
          <KpiCard label="Referrers"      value={String(referrers.length)}    sub="with ≥1 referred user"     accent={C.amberDim} dark={dark} />
        </div>

        {/* ── Charts row ── */}
        <div style={{ display: "grid", gridTemplateColumns: "1.8fr 1fr", gap: 16, marginTop: "1rem" }}>

          {/* Player progress */}
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "1.25rem" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 14 }}>
              <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: T.creamMute, margin: 0 }}>Player Progress</p>
              <div style={{ position: "relative", width: 150, flexShrink: 0 }}>
                <input
                  value={playerSearchQuery}
                  onChange={(e) => setPlayerSearchQuery(e.target.value)}
                  placeholder="Search FID / @user"
                  style={{
                    width: "100%",
                    fontSize: 11,
                    padding: "6px 24px 6px 10px",
                    borderRadius: 7,
                    background: T.surfaceAlt,
                    border: `1px solid ${T.border}`,
                    color: T.cream,
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
                {playerSearchQuery && (
                  <button
                    onClick={() => setPlayerSearchQuery("")}
                    style={{
                      position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
                      background: "transparent", border: "none", cursor: "pointer",
                      color: T.textMute, fontSize: 12, lineHeight: 1, padding: 2,
                    }}
                    title="Clear search"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
            {users.length === 0 ? (
              <p style={{ fontSize: 13, color: T.textMute }}>No players yet.</p>
            ) : (
              <>
                <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: C.green, margin: "0 0 8px" }}>
                  Real Players · {(playerSearchQuery || globalSearchQuery) ? `${filteredRealUsers.length}/${realUsers.length}` : realUsers.length}
                </p>
                {filteredRealUsers.length === 0 ? (
                  <p style={{ fontSize: 12, color: T.textMute, margin: "0 0 14px" }}>{(playerSearchQuery || globalSearchQuery) ? "No matches." : "None yet."}</p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 220, overflowY: "auto", paddingRight: 10, marginBottom: 16 }}>
                    {[...filteredRealUsers].sort((a, b) => (b.xp || 0) - (a.xp || 0)).map((u) => {
                      const profile = profiles[String(u.fid)];
                      return (
                      <div key={u.fid} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{ width: 72, flexShrink: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                          <button
                            onClick={() => { setLookupFid(u.fid); loadUserControl(u.fid); }}
                            style={{ fontSize: 11, color: dark ? C.amberGlow : "#7c3aed", background: "transparent", border: "none", cursor: "pointer", fontFamily: "monospace", textAlign: "left", padding: 0, textShadow: dark ? `0 0 8px ${C.amberGlow}66` : "none" }}
                            title="Open in user panel"
                          >
                            #{u.fid}
                          </button>
                          {profile?.username ? (
                            <a
                              href={`https://farcaster.xyz/${profile.username}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ fontSize: 10, color: T.textSub, textDecoration: "none", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                              title={profile.displayName ?? profile.username}
                            >
                              @{profile.username}
                            </a>
                          ) : profile === undefined ? (
                            <span style={{ fontSize: 10, color: T.textMute }}>…</span>
                          ) : (
                            <span style={{ fontSize: 10, color: T.textMute }}>—</span>
                          )}
                        </div>
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
                      );
                    })}
                  </div>
                )}

                <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: dark ? "#cbd5e1" : T.textMute, margin: "0 0 8px" }}>
                  Unconverted Opens · {(playerSearchQuery || globalSearchQuery) ? `${filteredGhostUsers.length}/${ghostUsers.length}` : ghostUsers.length}
                </p>
                {filteredGhostUsers.length === 0 ? (
                  <p style={{ fontSize: 12, color: T.textMute }}>{(playerSearchQuery || globalSearchQuery) ? "No matches." : "None — every opener has progressed."}</p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 140, overflowY: "auto", paddingRight: 10 }}>
                    {filteredGhostUsers.map((u) => {
                      const profile = profiles[String(u.fid)];
                      return (
                        <div key={u.fid} style={{ display: "flex", alignItems: "center", gap: 12, opacity: 0.85 }}>
                          <button
                            onClick={() => { setLookupFid(u.fid); loadUserControl(u.fid); }}
                            style={{ fontSize: 13, color: dark ? C.amberGlow : "#7c3aed", background: "transparent", border: "none", cursor: "pointer", fontFamily: "monospace", textAlign: "left", padding: 0, fontWeight: 600 }}
                            title="Open in user panel"
                          >
                            #{u.fid}
                          </button>
                          {profile?.username ? (
                            <a
                              href={`https://farcaster.xyz/${profile.username}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ fontSize: 12, color: dark ? "#e5e7eb" : T.textSub, textDecoration: "none" }}
                              title={profile.displayName ?? profile.username}
                            >
                              @{profile.username}
                            </a>
                          ) : (
                            <span style={{ fontSize: 12, color: dark ? "#e5e7eb" : T.textSub }}>—</span>
                          )}
                          <span style={{ fontSize: 12, color: dark ? "#cbd5e1" : T.textMute, marginLeft: "auto" }}>0 xp · 0 ci</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
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
        <SectionLabel dark={dark}>Transaction Log</SectionLabel>
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: `1px solid ${T.borderSub}` }}>
            <span style={{ fontSize: 12, color: T.textMute }}>
              {globalSearchQuery
                ? `Showing ${filteredSortedTxns.length} matching "${globalSearchQuery}" (of last ${sortedTxns.length})`
                : `Showing last ${sortedTxns.length} of ${txns.length} total`}
            </span>
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
                {filteredSortedTxns.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ padding: "24px 14px", textAlign: "center", color: T.textMute }}>{globalSearchQuery ? "No matching transactions." : "No transactions logged yet."}</td>
                  </tr>
                ) : filteredSortedTxns.map((t, i) => {
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
                    amountColor = dark ? C.amberGlow : "#92400e";
                  } else if (t.amountUsd > 0) {
                    amount = `$${t.amountUsd.toFixed(2)}`;
                    amountColor = C.green;
                  } else if (t.amountDegen) {
                    amount = `${t.amountDegen} DEGEN`;
                    amountColor = dark ? C.amberGlow : "#92400e";
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
                      <td style={{ padding: "9px 14px", fontFamily: "monospace", color: dark ? C.amberGlow : "#7c3aed", fontSize: 11 }}>{t.fid}</td>
                      <td style={{ padding: "9px 14px", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: T.textSub }} title={detail}>{detail}</td>
                      <td style={{ padding: "9px 14px", textAlign: "right", fontWeight: 600, color: amountColor, fontVariantNumeric: "tabular-nums" }}>{amount}</td>
                      <td style={{ padding: "9px 14px", textAlign: "right", color: T.creamMute }}>{timeAgo(t.ts)}</td>
                      <td style={{ padding: "9px 14px", textAlign: "right" }}>
                        <a href={`https://basescan.org/tx/${t.txHash}`} target="_blank" rel="noopener noreferrer"
                          style={{ color: dark ? C.blue : "#1d4ed8", fontSize: 11, fontWeight: 600, textDecoration: "none" }}>
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

        {/* ── Webhook Event Log ── */}
        <SectionLabel dark={dark}>Webhook Event Log</SectionLabel>
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: `1px solid ${T.borderSub}` }}>
            <span style={{ fontSize: 12, color: T.textMute }}>
              {globalSearchQuery
                ? `${filteredWebhookEvents.length} matching "${globalSearchQuery}" (of ${webhookEvents.length})`
                : `Raw Farcaster/Base App events — last ${webhookEvents.length} (capped at 2000 in KV)`}
            </span>
          </div>
          <div style={{ overflowX: "auto", maxHeight: 320, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: T.surfaceAlt, position: "sticky", top: 0 }}>
                  {["Event", "FID", "App FID", "When"].map((h, i) => (
                    <th key={h} style={{
                      textAlign: i >= 2 ? "right" : "left",
                      padding: "9px 14px",
                      color: T.creamMute,
                      fontWeight: 700,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      fontSize: 10,
                      borderBottom: `1px solid ${T.border}`,
                      background: T.surfaceAlt,
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredWebhookEvents.length === 0 ? (
                  <tr>
                    <td colSpan={4} style={{ padding: "24px 14px", textAlign: "center", color: T.textMute }}>{globalSearchQuery ? "No matching events." : "No webhook events logged yet."}</td>
                  </tr>
                ) : filteredWebhookEvents.map((e, i) => {
                  const meta: Record<string, { color: string; bg: string }> = {
                    miniapp_added: { color: C.green, bg: C.greenDim },
                    miniapp_removed: { color: C.red, bg: C.redDim },
                    notifications_enabled: { color: C.blue, bg: C.blueDim },
                    notifications_disabled: { color: T.textSub, bg: T.surfaceAlt },
                  };
                  const m = meta[e.event] ?? { color: T.textSub, bg: T.surfaceAlt };
                  return (
                    <tr key={i} style={{ borderBottom: `1px solid ${T.borderSub}`, background: i % 2 === 0 ? "transparent" : T.surfaceAlt + "55" }}>
                      <td style={{ padding: "9px 14px" }}>
                        <Badge color={m.color} bg={m.bg}>{e.event}</Badge>
                      </td>
                      <td style={{ padding: "9px 14px", fontFamily: "monospace", color: dark ? C.amberGlow : "#7c3aed", fontSize: 11 }}>{e.fid}</td>
                      <td style={{ padding: "9px 14px", textAlign: "right", color: T.textSub }}>{e.appFid}</td>
                      <td style={{ padding: "9px 14px", textAlign: "right", color: T.creamMute }}>{timeAgo(e.ts)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── All Users — Notification Status ── */}
        <SectionLabel dark={dark} accent={C.red}>All Users — App & Notification Status</SectionLabel>
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: `1px solid ${T.borderSub}`, gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: T.textMute }}>
              Every known fid (pet state, notif token, or added event) — {notifStatusUsers.length} total · {addedButNotifOffCount} added with notifs off
            </span>
            <Input
              value={userSearch}
              onChange={setUserSearch}
              placeholder="Search fid or @username…"
              style={{ width: 220, fontSize: 12, padding: "6px 10px" }}
            />
          </div>
          <div style={{ overflowX: "auto", maxHeight: 420, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: T.surfaceAlt, position: "sticky", top: 0 }}>
                  {["FID", "Check-ins", "Last Check-in", "Last Seen", "Notif", "Added"].map((h, i) => (
                    <th key={h} style={{
                      textAlign: i >= 1 && i <= 3 ? "right" : "left",
                      padding: "9px 14px",
                      color: T.creamMute,
                      fontWeight: 700,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      fontSize: 10,
                      borderBottom: `1px solid ${T.border}`,
                      background: T.surfaceAlt,
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const q = userSearch.trim().toLowerCase();
                  const filtered = q
                    ? notifStatusUsers.filter((u) => {
                        // Local box has text — it takes precedence, global is ignored
                        const uname = profiles[String(u.fid)]?.username?.toLowerCase() ?? "";
                        return String(u.fid).includes(q) || uname.includes(q.replace(/^@/, ""));
                      })
                    : notifStatusUsers.filter((u) => globalMatchesFid(u.fid)); // local empty — fall back to global
                  const noneReason = q
                    ? `No users matching "${userSearch}".`
                    : globalSearchQuery
                    ? `No users matching global "${globalSearchQuery}".`
                    : "No users found.";
                  return filtered.length === 0 ? (
                    <tr>
                      <td colSpan={6} style={{ padding: "24px 14px", textAlign: "center", color: T.textMute }}>
                        {noneReason}
                      </td>
                    </tr>
                  ) : filtered.map((u, i) => {
                  const profile = profiles[String(u.fid)];
                  const flagged = u.hasAddedApp && !u.hasNotifToken;
                  return (
                    <tr key={u.fid} style={{
                      borderBottom: `1px solid ${T.borderSub}`,
                      background: flagged ? (dark ? C.redDim + "55" : "#fee2e215") : (i % 2 === 0 ? "transparent" : T.surfaceAlt + "55"),
                    }}>
                      <td style={{ padding: "9px 14px" }}>
                        <button
                          onClick={() => { setLookupFid(u.fid); loadUserControl(u.fid); }}
                          style={{ fontSize: 11, color: dark ? C.amberGlow : "#7c3aed", background: "transparent", border: "none", cursor: "pointer", fontFamily: "monospace", textAlign: "left", padding: 0, fontWeight: 600 }}
                          title="Open in user panel"
                        >
                          #{u.fid}
                        </button>
                        {profile?.username && (
                          <span style={{ fontSize: 10, color: T.textMute, marginLeft: 6 }}>@{profile.username}</span>
                        )}
                        {u.noPetState && (
                          <span style={{ fontSize: 9, color: T.textMute, marginLeft: 6, fontStyle: "italic" }}>never opened</span>
                        )}
                      </td>
                      <td style={{ padding: "9px 14px", textAlign: "right", color: T.textSub, fontVariantNumeric: "tabular-nums" }}>{u.totalCheckIns ?? 0}</td>
                      <td style={{ padding: "9px 14px", textAlign: "right", color: T.textSub }}>{u.lastCheckInDay ?? "never"}</td>
                      <td style={{ padding: "9px 14px", textAlign: "right", color: T.creamMute }}>{u.lastVisit && u.lastVisit !== "unknown" ? timeAgo(new Date(u.lastVisit).getTime()) : "unknown"}</td>
                      <td style={{ padding: "9px 14px" }}><NotifPill on={u.hasNotifToken} dark={dark} /></td>
                      <td style={{ padding: "9px 14px" }}><NotifPill on={u.hasAddedApp} dark={dark} /></td>
                    </tr>
                  );
                  });
                })()}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Referral tree ── */}
        <SectionLabel dark={dark}>Referral Tree</SectionLabel>
        {filteredReferrers.length === 0 ? (
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "1.25rem" }}><p style={{ fontSize: 13, color: T.textMute, margin: 0 }}>{globalSearchQuery ? "No matching referrers." : "No referrals yet."}</p></div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 10 }}>
            {filteredReferrers.map((u) => (
              <div key={u.fid} style={{
                background: T.surface,
                border: `1px solid ${T.border}`,
                borderRadius: 10,
                padding: "12px 14px",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <button
                    onClick={() => { setLookupFid(u.fid); loadUserControl(u.fid); }}
                    style={{ fontSize: 13, fontWeight: 700, color: dark ? C.amberGlow : "#7c3aed", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: 0, textShadow: dark ? `0 0 10px ${C.amberGlow}66` : "none" }}
                  >
                    FID {u.fid}
                  </button>
                  <span style={{ fontSize: 12, fontWeight: 700, color: dark ? C.amberGlow2 : "#92400e" }}>+{u.referrals?.degenEarned} DEGEN</span>
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
                      #{r.fid} · {r.checkins} {r.checkins === 1 ? "Check In" : "Check Ins"}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── User control panel ── */}
        <SectionLabel dark={dark}>Manage User</SectionLabel>
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
                      <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: dark ? C.amberGlow : "#7c3aed", margin: "0 0 4px" }}>Set Sponsor</p>
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
                            background: T.bg, border: `1px solid ${dark ? C.amberGlow : "#7c3aed"}55`,
                            color: dark ? C.amberGlow : "#7c3aed", fontWeight: 500,
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
