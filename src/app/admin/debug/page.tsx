"use client";
import { useAuth } from "@clerk/nextjs";
import { useEffect, useState } from "react";

type ReferralDetail = { fid: number; checkins: number; status: string };

type UserEntry = {
  fid: string;
  streak: number;
  checkinStreak: number;
  streakBug: boolean;
  totalCheckIns: number;
  xp: number;
  bond: number;
  glimmer: number;
  hunger: number;
  happiness: number;
  lastCheckInDay: string;
  lastVisit: string;
  actionsToday: Record<string, unknown>;
  accessoriesUnlockedCount: number;
  accessoriesUnlocked: string[];
  referrals: {
    referredBy: number | null;
    referredCount: number;
    referredUsers: ReferralDetail[];
    degenEarned: number;
  };
  error?: string;
};

type DebugData = {
  ping: string;
  totalUsers: number;
  buggedStreakCount: number;
  usersWithAccessoriesCount: number;
  users: UserEntry[];
};

export default function DebugKVPage() {
  const { getToken } = useAuth();
  const [data, setData] = useState<DebugData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const token = await getToken();
        const res = await fetch("/api/debug-kv", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(`${res.status} — ${body.error ?? "Unknown error"}`);
          return;
        }
        setData(await res.json());
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filtered = data?.users.filter((u) =>
    u.fid.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>🐱 Grub KV Debug</h1>
          <p style={styles.subtitle}>Live pet state across all users</p>
        </div>
        {data && (
          <div style={styles.stats}>
            <Stat label="Total Users" value={data.totalUsers} />
            <Stat label="Streak Bugs" value={data.buggedStreakCount} warn={data.buggedStreakCount > 0} />
            <Stat label="With Accessories" value={data.usersWithAccessoriesCount} />
            <Stat label="KV Ping" value={data.ping === "pong" ? "✅" : "❌"} />
          </div>
        )}
      </div>

      {loading && <p style={styles.message}>Loading KV data…</p>}
      {error && <p style={{ ...styles.message, color: "#f87171" }}>Error: {error}</p>}

      {data && (
        <>
          <input
            style={styles.search}
            placeholder="Search by FID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  {["FID", "Streak", "CheckinStreak", "Bug?", "XP", "Bond", "Glimmer", "Hunger", "Happiness", "Total Check-ins", "Accessories", "Referrals", "Last Visit"].map((h) => (
                    <th key={h} style={styles.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered?.map((u) => (
                  <>
                    <tr
                      key={u.fid}
                      style={{ ...styles.tr, cursor: "pointer", background: expanded === u.fid ? "#1e293b" : "transparent" }}
                      onClick={() => setExpanded(expanded === u.fid ? null : u.fid)}
                    >
                      <td style={styles.td}><code style={styles.code}>{u.fid}</code></td>
                      <td style={styles.tdNum}>{u.streak}</td>
                      <td style={styles.tdNum}>{u.checkinStreak}</td>
                      <td style={{ ...styles.td, color: u.streakBug ? "#f87171" : "#4ade80", textAlign: "center" }}>
                        {u.streakBug ? "⚠️" : "✓"}
                      </td>
                      <td style={styles.tdNum}>{u.xp}</td>
                      <td style={styles.tdNum}>{u.bond}</td>
                      <td style={styles.tdNum}>{u.glimmer}</td>
                      <td style={styles.tdNum}>{u.hunger}</td>
                      <td style={styles.tdNum}>{u.happiness}</td>
                      <td style={styles.tdNum}>{u.totalCheckIns}</td>
                      <td style={styles.tdNum}>{u.accessoriesUnlockedCount}</td>
                      <td style={styles.tdNum}>{u.referrals?.referredCount ?? 0}</td>
                      <td style={{ ...styles.td, fontSize: 11, color: "#94a3b8" }}>
                        {u.lastVisit === "unknown" ? "—" : new Date(u.lastVisit).toLocaleDateString()}
                      </td>
                    </tr>
                    {expanded === u.fid && (
                      <tr key={`${u.fid}-expand`}>
                        <td colSpan={13} style={styles.expandCell}>
                          <div style={styles.expandGrid}>
                            <Section title="Actions Today">
                              <pre style={styles.pre}>{JSON.stringify(u.actionsToday, null, 2)}</pre>
                            </Section>
                            <Section title="Accessories">
                              {u.accessoriesUnlocked.length > 0
                                ? u.accessoriesUnlocked.map((a) => <Tag key={a} label={a} />)
                                : <span style={styles.dim}>None</span>}
                            </Section>
                            <Section title="Referrals">
                              <p style={styles.dim}>Referred by: {u.referrals?.referredBy ?? "—"}</p>
                              <p style={styles.dim}>DEGEN earned: {u.referrals?.degenEarned ?? 0}</p>
                              {u.referrals?.referredUsers?.map((r) => (
                                <div key={r.fid} style={styles.refRow}>
                                  <span>FID {r.fid}</span>
                                  <span style={styles.dim}>{r.checkins} check-ins</span>
                                  <Tag label={r.status} color={r.status === "paid" ? "#4ade80" : "#94a3b8"} />
                                </div>
                              ))}
                            </Section>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div style={styles.statBox}>
      <span style={{ ...styles.statVal, color: warn ? "#f87171" : "#e2e8f0" }}>{value}</span>
      <span style={styles.statLabel}>{label}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={styles.section}>
      <p style={styles.sectionTitle}>{title}</p>
      {children}
    </div>
  );
}

function Tag({ label, color = "#7c3aed" }: { label: string; color?: string }) {
  return (
    <span style={{ ...styles.tag, background: color + "22", color, borderColor: color + "44" }}>
      {label}
    </span>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: "100vh", background: "#0f172a", color: "#e2e8f0", fontFamily: "ui-monospace, monospace", padding: "24px" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, flexWrap: "wrap", gap: 16 },
  title: { fontSize: 22, fontWeight: 700, margin: 0, color: "#f8fafc" },
  subtitle: { fontSize: 13, color: "#64748b", margin: "4px 0 0" },
  stats: { display: "flex", gap: 12, flexWrap: "wrap" },
  statBox: { background: "#1e293b", border: "1px solid #334155", borderRadius: 8, padding: "10px 16px", textAlign: "center", minWidth: 90 },
  statVal: { display: "block", fontSize: 20, fontWeight: 700 },
  statLabel: { display: "block", fontSize: 11, color: "#64748b", marginTop: 2 },
  message: { color: "#94a3b8", padding: "40px 0", textAlign: "center" },
  search: { width: "100%", maxWidth: 300, background: "#1e293b", border: "1px solid #334155", borderRadius: 8, padding: "8px 12px", color: "#e2e8f0", fontSize: 13, marginBottom: 16, outline: "none" },
  tableWrap: { overflowX: "auto", borderRadius: 10, border: "1px solid #1e293b" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { padding: "10px 12px", textAlign: "left", background: "#1e293b", color: "#64748b", fontWeight: 600, fontSize: 11, whiteSpace: "nowrap", borderBottom: "1px solid #334155" },
  tr: { borderBottom: "1px solid #1e293b", transition: "background 0.1s" },
  td: { padding: "10px 12px", verticalAlign: "middle" },
  tdNum: { padding: "10px 12px", textAlign: "right", verticalAlign: "middle", color: "#cbd5e1" },
  code: { background: "#1e293b", padding: "2px 6px", borderRadius: 4, fontSize: 12 },
  expandCell: { padding: "12px 16px", background: "#1e293b", borderBottom: "1px solid #334155" },
  expandGrid: { display: "flex", gap: 24, flexWrap: "wrap" },
  section: { minWidth: 180 },
  sectionTitle: { fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", marginBottom: 8 },
  pre: { fontSize: 11, color: "#94a3b8", margin: 0, whiteSpace: "pre-wrap" },
  dim: { color: "#64748b", fontSize: 12, margin: "2px 0", display: "block" },
  tag: { display: "inline-block", fontSize: 11, padding: "2px 8px", borderRadius: 99, border: "1px solid", marginRight: 4, marginBottom: 4 },
  refRow: { display: "flex", gap: 10, alignItems: "center", fontSize: 12, marginBottom: 4 },
};
