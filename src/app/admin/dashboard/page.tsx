// app/admin/dashboard/page.tsx
//
// Standalone admin dashboard — open at https://grub-app-eight.vercel.app/admin/dashboard
// Pulls live data from /api/debug-kv and /api/txn-log?all=1 (no auth — open by request).
// Pure client component: no server-side data fetching, just fetch() on mount + refresh button.

"use client";

import { useEffect, useState, useCallback } from "react";

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
  const [users, setUsers] = useState<DebugUser[]>([]);
  const [txns, setTxns] = useState<TxnEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastLoaded, setLastLoaded] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [debugRes, txnRes] = await Promise.all([
        fetch("/api/debug-kv").then((r) => r.json()),
        fetch("/api/txn-log?all=1").then((r) => r.json()),
      ]);
      setUsers(debugRes.users ?? []);
      setTxns(txnRes.log ?? []);
      setLastLoaded(new Date());
    } catch (err: any) {
      setError(err?.message ?? "Failed to load dashboard data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
            Couldn&apos;t load dashboard data: {error}
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
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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
      </div>
    </div>
  );
}
