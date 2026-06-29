"use client";
import { useAuth } from "@clerk/nextjs";
import { useEffect, useState } from "react";

type TxnLogEntry = {
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
  accessory_unlock: "#a78bfa",
  checkin: "#34d399",
  referral_join: "#60a5fa",
  referral_checkin: "#f59e0b",
};

export default function TxnLogPage() {
  const { getToken } = useAuth();
  const [log, setLog] = useState<TxnLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");

  useEffect(() => {
    (async () => {
      try {
        const token = await getToken();
        const res = await fetch("/api/txn-log?all=1", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(`${res.status} — ${body.error ?? "Unknown error"}`);
          return;
        }
        const data = await res.json();
        setLog(data.log ?? []);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filtered = log.filter((e) => {
    const matchFid = search ? String(e.fid).includes(search) || (e.txHash ?? "").toLowerCase().includes(search.toLowerCase()) : true;
    const matchType = typeFilter === "all" ? true : e.type === typeFilter;
    return matchFid && matchType;
  });

  const totalUsd = filtered.reduce((s, e) => s + (e.amountUsd ?? 0), 0);
  const totalDegen = filtered.reduce((s, e) => s + (e.amountDegen ?? 0), 0);

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>📋 Transaction Log</h1>
          <p style={styles.subtitle}>All on-chain actions across Grub</p>
        </div>
        <div style={styles.stats}>
          <Stat label="Total Txns" value={log.length} />
          <Stat label="Filtered" value={filtered.length} />
          <Stat label="Total USD" value={`$${totalUsd.toFixed(2)}`} />
          <Stat label="Total DEGEN" value={totalDegen} />
        </div>
      </div>

      {loading && <p style={styles.message}>Loading transactions…</p>}
      {error && <p style={{ ...styles.message, color: "#f87171" }}>Error: {error}</p>}

      {!loading && !error && (
        <>
          <div style={styles.filters}>
            <input
              style={styles.search}
              placeholder="Search FID or tx hash…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div style={styles.typeFilters}>
              {["all", "checkin", "accessory_unlock", "referral_join", "referral_checkin"].map((t) => (
                <button
                  key={t}
                  style={{
                    ...styles.filterBtn,
                    background: typeFilter === t ? (TYPE_COLORS[t] ?? "#6366f1") + "22" : "transparent",
                    color: typeFilter === t ? (TYPE_COLORS[t] ?? "#6366f1") : "#64748b",
                    borderColor: typeFilter === t ? (TYPE_COLORS[t] ?? "#6366f1") + "66" : "#334155",
                  }}
                  onClick={() => setTypeFilter(t)}
                >
                  {t === "all" ? "All" : t.replace(/_/g, " ")}
                </button>
              ))}
            </div>
          </div>

          {filtered.length === 0 ? (
            <p style={styles.message}>No transactions found.</p>
          ) : (
            <div style={styles.tableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    {["Time", "FID", "Type", "Tx Hash", "USD", "DEGEN", "To FID", "Accessory", "Wallet"].map((h) => (
                      <th key={h} style={styles.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((e, i) => (
                    <tr key={`${e.txHash}-${i}`} style={styles.tr}>
                      <td style={{ ...styles.td, color: "#64748b", fontSize: 11, whiteSpace: "nowrap" }}>
                        {new Date(e.ts).toLocaleString()}
                      </td>
                      <td style={styles.td}>
                        <code style={styles.code}>{e.fid}</code>
                      </td>
                      <td style={styles.td}>
                        <span style={{
                          ...styles.tag,
                          background: (TYPE_COLORS[e.type] ?? "#94a3b8") + "22",
                          color: TYPE_COLORS[e.type] ?? "#94a3b8",
                          borderColor: (TYPE_COLORS[e.type] ?? "#94a3b8") + "44",
                        }}>
                          {e.type.replace(/_/g, " ")}
                        </span>
                      </td>
                      <td style={styles.td}>
                        <a
                          href={`https://basescan.org/tx/${e.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={styles.link}
                        >
                          {e.txHash ? `${e.txHash.slice(0, 8)}…${e.txHash.slice(-6)}` : "—"}
                        </a>
                      </td>
                      <td style={styles.tdNum}>{e.amountUsd != null ? `$${e.amountUsd.toFixed(2)}` : "—"}</td>
                      <td style={styles.tdNum}>{e.amountDegen ?? "—"}</td>
                      <td style={styles.tdNum}>{e.toFid ?? "—"}</td>
                      <td style={styles.td}>
                        {e.accessoryName
                          ? <span style={{ ...styles.tag, background: "#a78bfa22", color: "#a78bfa", borderColor: "#a78bfa44" }}>{e.accessoryName}</span>
                          : <span style={styles.dim}>—</span>}
                      </td>
                      <td style={{ ...styles.td, fontSize: 11, color: "#64748b" }}>
                        {e.toWallet ? `${e.toWallet.slice(0, 6)}…${e.toWallet.slice(-4)}` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={styles.statBox}>
      <span style={styles.statVal}>{value}</span>
      <span style={styles.statLabel}>{label}</span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: "100vh", background: "#0f172a", color: "#e2e8f0", fontFamily: "ui-monospace, monospace", padding: "24px" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, flexWrap: "wrap", gap: 16 },
  title: { fontSize: 22, fontWeight: 700, margin: 0, color: "#f8fafc" },
  subtitle: { fontSize: 13, color: "#64748b", margin: "4px 0 0" },
  stats: { display: "flex", gap: 12, flexWrap: "wrap" },
  statBox: { background: "#1e293b", border: "1px solid #334155", borderRadius: 8, padding: "10px 16px", textAlign: "center", minWidth: 90 },
  statVal: { display: "block", fontSize: 20, fontWeight: 700, color: "#e2e8f0" },
  statLabel: { display: "block", fontSize: 11, color: "#64748b", marginTop: 2 },
  message: { color: "#94a3b8", padding: "40px 0", textAlign: "center" },
  filters: { display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap", alignItems: "center" },
  search: { background: "#1e293b", border: "1px solid #334155", borderRadius: 8, padding: "8px 12px", color: "#e2e8f0", fontSize: 13, outline: "none", minWidth: 220 },
  typeFilters: { display: "flex", gap: 6, flexWrap: "wrap" },
  filterBtn: { border: "1px solid", borderRadius: 99, padding: "5px 12px", fontSize: 12, cursor: "pointer", transition: "all 0.15s", fontFamily: "ui-monospace, monospace" },
  tableWrap: { overflowX: "auto", borderRadius: 10, border: "1px solid #1e293b" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { padding: "10px 12px", textAlign: "left", background: "#1e293b", color: "#64748b", fontWeight: 600, fontSize: 11, whiteSpace: "nowrap", borderBottom: "1px solid #334155" },
  tr: { borderBottom: "1px solid #1e293b" },
  td: { padding: "10px 12px", verticalAlign: "middle" },
  tdNum: { padding: "10px 12px", textAlign: "right", verticalAlign: "middle", color: "#cbd5e1" },
  code: { background: "#1e293b", padding: "2px 6px", borderRadius: 4, fontSize: 12 },
  tag: { display: "inline-block", fontSize: 11, padding: "2px 8px", borderRadius: 99, border: "1px solid" },
  link: { color: "#60a5fa", textDecoration: "none", fontFamily: "ui-monospace, monospace", fontSize: 12 },
  dim: { color: "#475569", fontSize: 12 },
};
