// app/admin/dashboard/page.tsx
//
// Secured admin dashboard.
// Open at: https://grub-app-eight.vercel.app/admin/dashboard?secret=YOUR_SECRET
//
// The secret is read from the URL on mount and forwarded to every API call.
// If it's missing or wrong, all API calls return 401 and an error banner is shown.
// The secret is NEVER stored in localStorage — it lives only in component state
// for the lifetime of the tab.

"use client";

import { useEffect, useState, useCallback } from "react";
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

const TYPE_COLORS: Record<string, string> = {
  accessory_unlock: "#2a78d6",
  checkin: "#1baf7a",
  referral_join: "#eda100",
  referral_checkin: "#4a3aa7",
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

function MetricCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ background: "#161513", borderRadius: 10, padding: "1rem", flex: 1, minWidth: 140 }}>
      <p style={{ fontSize: 13, color: "#898781", margin: "0 0 4px" }}>{label}</p>
      <p style={{ fontSize: 24, fontWeight: 500, margin: 0, color: "#fafaf8" }}>{value}</p>
      {sub && <p style={{ fontSize: 12, color: "#898781", margin: "4px 0 0" }}>{sub}</p>}
    </div>
  );
}

export default function AdminDashboardPage() {
  const searchParams = useSearchParams();
  const secret = searchParams.get("secret") ?? "";

  const [users, setUsers] = useState<DebugUser[]>([]);
  const [txns, setTxns] = useState<TxnEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastLoaded, setLastLoaded] = useState<Date | null>(null);

  // ── User control panel state ──────────────────────────────────────────
  const [lookupFid, setLookupFid] = useState("");
  const [controlState, setControlState] = useState<any>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [controlLoading, setControlLoading] = useState(false);
  const [controlMsg, setControlMsg] = useState<string | null>(null);
  const [statDrafts, setStatDrafts] = useState<{ xp: string; bond: string; glimmer: string; hunger: string; happiness: string }>({
    xp: "", bond: "", glimmer: "", hunger: "", happiness: "",
  });
  const [accessoryToRevoke, setAccessoryToRevoke] = useState("");
  const [accessoryToUnlock, setAccessoryToUnlock] = useState("");
  const [newReferrerFid, setNewReferrerFid] = useState("");

  // ── Helpers that inject the secret into every request ─────────────────
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
          xp: String(res.state.xp),
          bond: String(res.state.bond),
          glimmer: String(res.state.glimmer),
          hunger: String(res.state.hunger),
          happiness: String(res.state.happiness),
        });
      }
    } catch (err: any) {
      setControlError(err?.message ?? "Failed to load user");
    } finally {
      setControlLoading(false);
    }
  }, [authedGet]);

  const runAction = useCallback(
    async (action: string, extra: Record<string, any> = {}) => {
      if (!lookupFid) return;
      setControlMsg(null);
      setControlError(null);
      try {
        const res = await authedPost("/api/admin/user-control", { fid: lookupFid, action, ...extra });
        if (!res.ok) {
          setControlError(res.reason ?? "Action failed");
        } else {
          setControlMsg(
            res.warning
              ? `Done — but note: ${res.warning}`
              : `${action.replace(/_/g, " ")} applied.`
          );
          loadUserControl(lookupFid);
        }
      } catch (err: any) {
        setControlError(err?.message ?? "Action failed");
      }
    },
    [lookupFid, loadUserControl, authedPost]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [debugRes, txnRes] = await Promise.all([
        authedGet("/api/debug-kv"),
        authedGet("/api/txn-log?all=1"),
      ]);
      if (debugRes.error === "Unauthorized" || txnRes.error === "Unauthorized") {
        setError("Unauthorized — check your ?secret= in the URL.");
        setUsers([]);
        setTxns([]);
        return;
      }
      setUsers(debugRes.users ?? []);
      setTxns(txnRes.log ?? []);
      setLastLoaded(new Date());
    } catch (err: any) {
      setError(err?.message ?? "Failed to load dashboard data");
    } finally {
      setLoading(false);
    }
  }, [authedGet]);

  useEffect(() => {
    if (!secret) {
      setError("No secret provided. Open this page as /admin/dashboard?secret=YOUR_SECRET");
      setLoading(false);
      return;
    }
    load();
  }, [load, secret]);

  const totalUsers = users.length;
  const usersWithAcc = users.filter((u) => (u.accessoriesUnlockedCount ?? 0) > 0).length;
  const usdcTxns = txns.filter((t) => t.amountUsd > 0);
  const totalUsdc = usdcTxns.reduce((s, t) => s + (t.amountUsd || 0), 0);
  const totalDegenPaid = txns.reduce((s, t) => s + (t.amountDegen || 0), 0);
  const referrers = users.filter((u) => (u.referrals?.referredCount ?? 0) > 0);

  const byType: Record<string, number> = {};
  for (const t of txns) byType[t.type] = (byType[t.type] ?? 0) + 1;

  const sortedTxns = [...txns].sort((a, b) => b.ts - a.ts).slice(0, 40);
  const maxXp = Math.max(1, ...users.map((u) => u.xp || 0));
  const maxCheckins = Math.max(1, ...users.map((u) => u.totalCheckIns || 0));

  return (
    <div style={{ minHeight: "100vh", background: "#0e0d0c", color: "#fafaf8", fontFamily: "system-ui, sans-serif", padding: "2rem 1.5rem" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.5rem" }}>
          <div>
            <p style={{ fontSize: 13, color: "#898781", margin: 0 }}>Grub</p>
            <h1 style={{ fontSize: 22, fontWeight: 500, margin: "2px 0 0" }}>Admin dashboard</h1>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {lastLoaded && (
              <span style={{ fontSize: 12, color: "#898781" }}>
                Updated {timeAgo(lastLoaded.getTime())}
              </span>
            )}
            <button
              onClick={load}
              disabled={loading}
              style={{
                background: "transparent",
                border: "0.5px solid #44443f",
                borderRadius: 8,
                color: "#fafaf8",
                padding: "8px 14px",
                fontSize: 13,
                cursor: loading ? "default" : "pointer",
                opacity: loading ? 0.6 : 1,
              }}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        {error && (
          <div style={{ padding: "10px 12px", borderRadius: 8, background: "#412402", color: "#fac775", fontSize: 13, marginBottom: "1rem" }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: 12, marginBottom: "1.5rem", flexWrap: "wrap" }}>
          <MetricCard label="Active players" value={String(totalUsers)} sub="have a saved pet" />
          <MetricCard label="USDC collected" value={`$${totalUsdc.toFixed(2)}`} sub={`${usdcTxns.length} purchases logged`} />
          <MetricCard label="DEGEN paid out" value={totalDegenPaid.toFixed(0)} sub="across referral rewards" />
          <MetricCard label="Accessory owners" value={String(usersWithAcc)} sub={`of ${totalUsers} players`} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 16, marginBottom: "1.5rem" }}>
          <div style={{ background: "#161513", borderRadius: 10, padding: "1rem" }}>
            <p style={{ fontSize: 13, color: "#898781", margin: "0 0 12px" }}>Player progress</p>
            {users.length === 0 ? (
              <p style={{ fontSize: 13, color: "#5f5e5a" }}>No players yet.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {users.map((u) => (
                  <div key={u.fid} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 12, color: "#898781", width: 70, flexShrink: 0 }}>{u.fid}</span>
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <div style={{ height: 7, background: "#2a78d6", borderRadius: 3, width: `${((u.xp || 0) / maxXp) * 100}%`, minWidth: 2 }} />
                        <span style={{ fontSize: 11, color: "#898781" }}>{u.xp || 0} xp</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <div style={{ height: 7, background: "#1baf7a", borderRadius: 3, width: `${((u.totalCheckIns || 0) / maxCheckins) * 100}%`, minWidth: 2 }} />
                        <span style={{ fontSize: 11, color: "#898781" }}>{u.totalCheckIns || 0} check-ins</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ background: "#161513", borderRadius: 10, padding: "1rem" }}>
            <p style={{ fontSize: 13, color: "#898781", margin: "0 0 12px" }}>Transactions by type</p>
            {Object.keys(byType).length === 0 ? (
              <p style={{ fontSize: 13, color: "#5f5e5a" }}>No transactions logged yet.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {Object.entries(byType).map(([type, count]) => (
                  <div key={type} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: TYPE_COLORS[type] ?? "#888780", flexShrink: 0 }} />
                    <span style={{ fontSize: 13, flex: 1 }}>{type}</span>
                    <span style={{ fontSize: 13, color: "#898781" }}>{count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <p style={{ fontSize: 13, color: "#898781", margin: 0 }}>Recent transactions</p>
          <span style={{ fontSize: 12, color: "#5f5e5a" }}>{txns.length} total logged</span>
        </div>
        <div style={{ background: "#161513", borderRadius: 10, overflow: "hidden", marginBottom: "1.5rem" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "0.5px solid #2c2c2a" }}>
                <th style={{ textAlign: "left", padding: "8px 12px", color: "#5f5e5a", fontWeight: 400 }}>Type</th>
                <th style={{ textAlign: "left", padding: "8px 12px", color: "#5f5e5a", fontWeight: 400 }}>Fid</th>
                <th style={{ textAlign: "left", padding: "8px 12px", color: "#5f5e5a", fontWeight: 400 }}>Detail</th>
                <th style={{ textAlign: "right", padding: "8px 12px", color: "#5f5e5a", fontWeight: 400 }}>Amount</th>
                <th style={{ textAlign: "right", padding: "8px 12px", color: "#5f5e5a", fontWeight: 400 }}>When</th>
                <th style={{ textAlign: "right", padding: "8px 12px", color: "#5f5e5a", fontWeight: 400 }}>Tx</th>
              </tr>
            </thead>
            <tbody>
              {sortedTxns.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: "20px 12px", textAlign: "center", color: "#5f5e5a" }}>
                    No transactions logged yet.
                  </td>
                </tr>
              ) : (
                sortedTxns.map((t, i) => {
                  let detail = "—";
                  let amount = "—";
                  if (t.type === "accessory_unlock") {
                    detail = t.accessoryName || t.accessoryId || "";
                    amount = `$${(t.amountUsd || 0).toFixed(2)}`;
                  } else if (t.type === "referral_join" || t.type === "referral_checkin") {
                    detail = `to fid ${t.toFid ?? "?"} (${shortAddr(t.toWallet)})`;
                    amount = `${t.amountDegen ?? 0} DEGEN`;
                  } else if (t.amountUsd > 0) {
                    amount = `$${t.amountUsd.toFixed(2)}`;
                  } else if (t.amountDegen) {
                    amount = `${t.amountDegen} DEGEN`;
                  }
                  return (
                    <tr key={i} style={{ borderBottom: "0.5px solid #2c2c2a" }}>
                      <td style={{ padding: "8px 12px" }}>{t.type}</td>
                      <td style={{ padding: "8px 12px" }}>{t.fid}</td>
                      <td style={{ padding: "8px 12px", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={detail}>
                        {detail}
                      </td>
                      <td style={{ padding: "8px 12px", textAlign: "right" }}>{amount}</td>
                      <td style={{ padding: "8px 12px", textAlign: "right", color: "#898781" }}>{timeAgo(t.ts)}</td>
                      <td style={{ padding: "8px 12px", textAlign: "right" }}>
                        <a
                          href={`https://basescan.org/tx/${t.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: "#378ADD", fontSize: 12 }}
                          title={t.txHash}
                        >
                          view
                        </a>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <p style={{ fontSize: 13, color: "#898781", margin: "0 0 10px" }}>Referral tree</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: "1.5rem" }}>
          {referrers.length === 0 ? (
            <p style={{ fontSize: 13, color: "#5f5e5a" }}>No one has referred anyone yet.</p>
          ) : (
            referrers.map((u) => (
              <div
                key={u.fid}
                style={{
                  background: "#161513",
                  border: "0.5px solid #2c2c2a",
                  borderRadius: 8,
                  padding: "10px 12px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div>
                  <span style={{ fontWeight: 500, fontSize: 14 }}>Fid {u.fid}</span>
                  <span style={{ fontSize: 13, color: "#898781", marginLeft: 8 }}>
                    referred {u.referrals?.referredCount} ·{" "}
                    {u.referrals?.referredUsers.map((r) => r.fid).join(", ")}
                  </span>
                </div>
                <span style={{ fontSize: 13, color: "#378ADD", fontWeight: 500 }}>
                  {u.referrals?.degenEarned} DEGEN
                </span>
              </div>
            ))
          )}
        </div>

        {/* ── User control panel ───────────────────────────────────────── */}
        <p style={{ fontSize: 13, color: "#898781", margin: "2rem 0 10px" }}>Manage user</p>
        <div style={{ background: "#161513", borderRadius: 10, padding: "1rem" }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input
              type="text"
              placeholder="Enter a fid"
              value={lookupFid}
              onChange={(e) => setLookupFid(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loadUserControl(lookupFid)}
              style={{
                flex: 1, background: "#0e0d0c", border: "0.5px solid #2c2c2a", borderRadius: 8,
                color: "#fafaf8", padding: "8px 12px", fontSize: 13,
              }}
            />
            <button
              onClick={() => loadUserControl(lookupFid)}
              disabled={controlLoading || !lookupFid}
              style={{
                background: "transparent", border: "0.5px solid #44443f", borderRadius: 8,
                color: "#fafaf8", padding: "8px 14px", fontSize: 13,
                cursor: controlLoading ? "default" : "pointer", opacity: controlLoading || !lookupFid ? 0.6 : 1,
              }}
            >
              {controlLoading ? "Loading…" : "Load"}
            </button>
          </div>

          {controlError && (
            <p style={{ fontSize: 13, color: "#fab219", margin: "0 0 12px" }}>{controlError}</p>
          )}
          {controlMsg && (
            <p style={{ fontSize: 13, color: "#1baf7a", margin: "0 0 12px" }}>{controlMsg}</p>
          )}

          {controlState && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ fontSize: 13, color: "#898781" }}>
                Fid {controlState.fid} ·{" "}
                {controlState.state.banned ? (
                  <span style={{ color: "#fab219" }}>banned</span>
                ) : (
                  "active"
                )}
                {controlState.referral?.referredByFid && (
                  <> · referred by {controlState.referral.referredByFid}</>
                )}
              </div>

              {/* Adjust stats */}
              <div>
                <p style={{ fontSize: 12, color: "#5f5e5a", margin: "0 0 8px" }}>Adjust stats</p>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, marginBottom: 8 }}>
                  {(["xp", "bond", "glimmer", "hunger", "happiness"] as const).map((field) => (
                    <div key={field}>
                      <label style={{ fontSize: 11, color: "#5f5e5a", display: "block", marginBottom: 4 }}>{field}</label>
                      <input
                        type="number"
                        value={statDrafts[field]}
                        onChange={(e) => setStatDrafts((d) => ({ ...d, [field]: e.target.value }))}
                        style={{
                          width: "100%", background: "#0e0d0c", border: "0.5px solid #2c2c2a", borderRadius: 8,
                          color: "#fafaf8", padding: "6px 8px", fontSize: 13, boxSizing: "border-box",
                        }}
                      />
                    </div>
                  ))}
                </div>
                <button
                  onClick={() =>
                    runAction("adjust_stats", {
                      xp: Number(statDrafts.xp),
                      bond: Number(statDrafts.bond),
                      glimmer: Number(statDrafts.glimmer),
                      hunger: Number(statDrafts.hunger),
                      happiness: Number(statDrafts.happiness),
                    })
                  }
                  style={{
                    background: "transparent", border: "0.5px solid #44443f", borderRadius: 8,
                    color: "#fafaf8", padding: "6px 12px", fontSize: 12, cursor: "pointer",
                  }}
                >
                  Save stats
                </button>
              </div>

              {/* Accessories */}
              <div>
                <p style={{ fontSize: 12, color: "#5f5e5a", margin: "0 0 8px" }}>
                  Accessories ({controlState.state.accessoriesUnlocked.length} unlocked)
                </p>

                {/* Unlocked list */}
                {controlState.state.accessoriesUnlocked.length === 0 ? (
                  <p style={{ fontSize: 13, color: "#5f5e5a", marginBottom: 8 }}>None unlocked yet.</p>
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                    {controlState.state.accessoriesUnlocked.map((id: string) => (
                      <span
                        key={id}
                        style={{
                          fontSize: 12, padding: "4px 10px", borderRadius: 999,
                          background: "#0e0d0c", border: "0.5px solid #2c2c2a", color: "#c3c2b7",
                        }}
                      >
                        {id}
                      </span>
                    ))}
                  </div>
                )}

                {/* Unlock a new accessory */}
                <div style={{ marginBottom: 8 }}>
                  <p style={{ fontSize: 11, color: "#5f5e5a", margin: "0 0 6px" }}>Grant / unlock accessory</p>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      type="text"
                      placeholder="accessory id to unlock"
                      value={accessoryToUnlock}
                      onChange={(e) => setAccessoryToUnlock(e.target.value)}
                      style={{
                        flex: 1, background: "#0e0d0c", border: "0.5px solid #2c2c2a", borderRadius: 8,
                        color: "#fafaf8", padding: "6px 10px", fontSize: 13,
                      }}
                    />
                    <button
                      onClick={() => {
                        runAction("unlock_accessory", { accessoryId: accessoryToUnlock });
                        setAccessoryToUnlock("");
                      }}
                      disabled={!accessoryToUnlock}
                      style={{
                        background: "#152a1a", border: "0.5px solid #1baf7a", borderRadius: 8,
                        color: "#1baf7a", padding: "6px 14px", fontSize: 12,
                        cursor: accessoryToUnlock ? "pointer" : "default", opacity: accessoryToUnlock ? 1 : 0.5,
                      }}
                    >
                      Unlock
                    </button>
                  </div>
                </div>

                {/* Revoke an existing accessory */}
                <div>
                  <p style={{ fontSize: 11, color: "#5f5e5a", margin: "0 0 6px" }}>Revoke accessory</p>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      type="text"
                      placeholder="accessory id to revoke"
                      value={accessoryToRevoke}
                      onChange={(e) => setAccessoryToRevoke(e.target.value)}
                      style={{
                        flex: 1, background: "#0e0d0c", border: "0.5px solid #2c2c2a", borderRadius: 8,
                        color: "#fafaf8", padding: "6px 10px", fontSize: 13,
                      }}
                    />
                    <button
                      onClick={() => {
                        runAction("revoke_accessory", { accessoryId: accessoryToRevoke });
                        setAccessoryToRevoke("");
                      }}
                      disabled={!accessoryToRevoke}
                      style={{
                        background: "transparent", border: "0.5px solid #44443f", borderRadius: 8,
                        color: "#fab219", padding: "6px 12px", fontSize: 12,
                        cursor: accessoryToRevoke ? "pointer" : "default", opacity: accessoryToRevoke ? 1 : 0.5,
                      }}
                    >
                      Revoke
                    </button>
                  </div>
                </div>
              </div>

              {/* Referral */}
              <div>
                <p style={{ fontSize: 12, color: "#5f5e5a", margin: "0 0 8px" }}>Referral relationship</p>
                <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  <input
                    type="text"
                    placeholder="new referrer fid"
                    value={newReferrerFid}
                    onChange={(e) => setNewReferrerFid(e.target.value)}
                    style={{
                      flex: 1, background: "#0e0d0c", border: "0.5px solid #2c2c2a", borderRadius: 8,
                      color: "#fafaf8", padding: "6px 10px", fontSize: 13,
                    }}
                  />
                  <button
                    onClick={() => runAction("edit_referral", { newReferrerFid })}
                    disabled={!newReferrerFid}
                    style={{
                      background: "transparent", border: "0.5px solid #44443f", borderRadius: 8,
                      color: "#fafaf8", padding: "6px 12px", fontSize: 12,
                      cursor: newReferrerFid ? "pointer" : "default", opacity: newReferrerFid ? 1 : 0.5,
                    }}
                  >
                    Set referrer
                  </button>
                  <button
                    onClick={() => runAction("edit_referral", { removeReferral: true })}
                    style={{
                      background: "transparent", border: "0.5px solid #44443f", borderRadius: 8,
                      color: "#fab219", padding: "6px 12px", fontSize: 12, cursor: "pointer",
                    }}
                  >
                    Remove referral
                  </button>
                </div>
              </div>

              {/* Ban / unban */}
              <div>
                <p style={{ fontSize: 12, color: "#5f5e5a", margin: "0 0 8px" }}>
                  Ban — blocks feeding, unlocking, and check-ins for this fid
                </p>
                <button
                  onClick={() => runAction(controlState.state.banned ? "unban" : "ban")}
                  style={{
                    background: "transparent",
                    border: `0.5px solid ${controlState.state.banned ? "#1baf7a" : "#44443f"}`,
                    borderRadius: 8,
                    color: controlState.state.banned ? "#1baf7a" : "#fab219",
                    padding: "6px 12px", fontSize: 12, cursor: "pointer",
                  }}
                >
                  {controlState.state.banned ? "Unban" : "Ban"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
