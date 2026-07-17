// app/admin/dashboard/page.tsx
// Protected by Clerk — only signed-in users can reach this page

"use client";

import { useEffect, useState, useCallback, useMemo, useRef, Suspense, Fragment } from "react";
import { useAuth, useClerk } from "@clerk/nextjs";

type DebugUser = {
  fid: string;
  xp: number;
  totalCheckIns: number;
  accessoriesUnlockedCount: number;
  accessoriesUnlocked: string[];
  freeCheckinCredits?: number;
  streakSaveCredits?: number;
  hasNotifToken?: boolean;
  hasAddedApp?: boolean;
  noPetState?: boolean;
  lastVisit: string;
  lastCheckInDay?: string;
  referrals?: {
    referredBy: number | string | null;
    referredCount: number;
    referredUsers: { fid: number | string; checkins: number; status: string }[];
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

// Mirrors SuggestionEntry in app/api/suggestion/route.ts — kept as a local
// copy since that file is server-only (imports @vercel/kv) and can't be
// imported into this client component.
type SuggestionMessage = { sender: "user" | "admin"; text: string; ts: number };
type SuggestionEntry = {
  id: string;
  fid: number | string | null;
  wallet: string | null;
  identity: string; // e.g. "fid:203912" or "wallet:0xabc…"
  type: "suggestion" | "issue";
  text: string;
  status: "new" | "seen" | "resolved" | "archived";
  ts: number;
  messages?: SuggestionMessage[]; // follow-up thread, issue-only
  unread?: boolean;               // true when user hasn't seen the latest admin reply
};

type FailedPayout = {
  id: string;
  fid: number | string;   // fid, or "wallet:0x..." for Base App — see lib/referral.ts
  toFid: number | string; // same
  toWallet: string;
  amountDegen: number;
  type: "referral_join" | "referral_checkin";
  reason: string;
  ts: number;
  sideEffect?: { kvKey: string; kvValue: any } | null;
  broadcastTxHash?: string | null;
};

// Mirrors CoinTossCredit in lib/minigames.ts — manual balance top-ups only.
// Deliberately separate from TxnEntry/txn-log: these aren't blockchain
// transactions, just internal balance adjustments, so they only ever show
// up in the mini-games admin block below, never in the main Transaction Log.
type CoinTossCreditEntry = {
  id: string;
  identityKey: string;
  amountDegen: number;
  reason: string;
  newBalance: number;
  ts: number;
  cancelled?: boolean;
  cancelledAt?: number;
};

// Mirrors CoinTossFlip in lib/minigames.ts — one resolved flip, including
// the HMAC provably-fair inputs it was resolved against.
type CoinTossFlipEntry = {
  id: string;
  identityKey: string;
  betDegen: number;
  choice: "heads" | "tails";
  result: "heads" | "tails";
  won: boolean;
  payoutDegen: number;
  feeTakenDegen: number;
  ts: number;
  serverSeedHash: string;
  nonce: number;
  clientSeed: string;
};

// Mirrors getActiveSeedSummary()'s return shape — the LIVE seed's public
// commitment only (never the raw seed while it's still active).
type ActiveSeedSummary = { serverSeedHash: string; flipsUsed: number; createdAt: number };

// Mirrors RevealedSeed in lib/minigames.ts — a seed that has rotated out,
// safe to show in full (raw serverSeed included) since it's done being
// used for new flips and anyone can now verify past ones against it.
type RevealedSeedEntry = {
  serverSeed: string;
  serverSeedHash: string;
  finalNonce: number;
  createdAt: number;
  revealedAt: number;
};

// Mirrors CoinTossPlayerStats in lib/minigames.ts — one player's aggregated
// Coin Toss stats (balance, deposits, won/lost, net P&L). Only ever includes
// identities that have placed at least one flip.
type CoinTossPlayerStats = {
  identityKey: string;
  balance: number;
  flips: number;
  wins: number;
  totalWagered: number;
  betOnWins: number;
  totalWon: number;
  totalLost: number;
  totalDeposited: number;
  netProfitLoss: number;
  lastPlayedAt: number;
};

// Mirrors DicePlayerStats in lib/minigames.ts — one player's aggregated
// Dice stats (balance, wagered, won/lost, net P&L). Shares the same
// internal balance as Coin Toss, so there's no totalDeposited field here —
// deposits are already covered by the Coin Toss mirror above. Only ever
// includes identities that have placed at least one roll.
type DicePlayerStats = {
  identityKey: string;
  balance: number;
  rolls: number;
  wins: number;
  totalWagered: number;
  betOnWins: number;
  totalWon: number;
  totalLost: number;
  netProfitLoss: number;
  lastPlayedAt: number;
};

// Mirrors DiceRoll in lib/minigames.ts — one resolved roll, including the
// HMAC provably-fair inputs it was resolved against. Own seed/nonce lineage
// from Coin Toss's CoinTossFlipEntry above — Dice rolls never share a
// serverSeedHash with a Coin Toss flip, even though both reuse the same
// per-identity clientSeed. No feeTakenDegen field: unlike Coin Toss, Dice
// has no separate on-win fee — its house edge is baked into the win-chance
// → multiplier formula itself.
type DiceRollEntry = {
  id: string;
  identityKey: string;
  betDegen: number;
  target: number;
  direction: "under" | "over";
  roll: number;
  won: boolean;
  winChancePercent: number;
  multiplier: number;
  payoutDegen: number;
  ts: number;
  serverSeedHash: string;
  nonce: number;
  clientSeed: string;
};

type TxnEntry = {
  fid: number | string; // string for Base App wallet-only users, e.g. "wallet:0xabc..."
  type: "accessory_unlock" | "checkin" | "referral_join" | "referral_checkin" | "wheel_spin" | "minigame_cashout";
  txHash: string;
  amountUsd: number;
  amountDegen?: number;
  toFid?: number | string; // same as fid — Base App referral payouts use "wallet:0x..." here too
  toWallet?: string;
  accessoryId?: string;
  accessoryName?: string;
  wheelReward?: string; // e.g. "You won: +1 XP!", "Rare Accessory: Gold Crown!"
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
  creamMute: "#a89bd0",
  green:     "#34d399",
  greenDim:  "#064e3b",
  blue:      "#60a5fa",
  blueDim:   "#1e3a5f",
  purple:    "#a78bfa",
  red:       "#f87171",
  redDim:    "#450a0a",
  text:      "#ede9fe",
  textSub:   "#c9bfe6",
  textMute:  "#948bb8",
};

const TYPE_META: Record<string, { color: string; bg: string; label: string }> = {
  accessory_unlock: { color: C.blue,    bg: C.blueDim,   label: "Accessory" },
  checkin:          { color: C.green,   bg: C.greenDim,  label: "Check-in"  },
  referral_join:    { color: C.amberGlow, bg: "#3b1f6e",  label: "Ref Join"  },
  referral_checkin: { color: C.purple,  bg: "#2e1f5e",   label: "Ref Check" },
  wheel_spin:       { color: "#e879f9", bg: "#4a1d5e",   label: "Spin Wheel" },
  minigame_cashout: { color: "#fb923c", bg: "#431407",   label: "Coin Toss Cash-out" },
  minigame_deposit: { color: "#22d3ee", bg: "#083344",   label: "Minigame Deposit" },
  raffle_ticket:    { color: "#fbbf24", bg: "#451a03",   label: "Raffle Ticket" },
  wheel_degen:      { color: "#2dd4bf", bg: "#042f2e",   label: "wheel_degen" },
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

// Same idea as timeAgo but for a FUTURE timestamp — used for the raffle's
// open-round lock countdown, which timeAgo can't express (it only ever
// reads "Xm ago").
function timeUntil(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 0) return "any moment";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

function shortAddr(s?: string): string {
  if (!s) return "";
  return s.length > 10 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

function shortHash(s?: string): string {
  if (!s) return "—";
  return s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
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

function Input({ value, onChange, placeholder, onKeyDown, style, dark = true }: {
  value: string; onChange: (v: string) => void; placeholder?: string; onKeyDown?: React.KeyboardEventHandler; style?: React.CSSProperties; dark?: boolean;
}) {
  const bg = dark ? C.bg : "#ffffff";
  const border = dark ? C.border : "#c4b5fd";
  const text = dark ? C.text : "#1a1a18";
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      style={{
        flex: 1,
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 8,
        color: text,
        padding: "8px 12px",
        fontSize: 13,
        outline: "none",
        fontFamily: "inherit",
        ...style,
      }}
    />
  );
}

function NumberInput({ label, value, onChange, dark = true }: { label: string; value: string; onChange: (v: string) => void; dark?: boolean }) {
  const bg = dark ? C.bg : "#ffffff";
  const border = dark ? C.border : "#c4b5fd";
  const text = dark ? C.text : "#1a1a18";
  const labelColor = dark ? C.creamDim : "#4c1d95";
  return (
    <div>
      <label style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: labelColor, display: "block", marginBottom: 5 }}>{label}</label>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          background: bg,
          border: `1px solid ${border}`,
          borderRadius: 8,
          color: text,
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

function FilterToggle({ label, value, onChange, dark = true }: {
  label: string; value: "all" | "on" | "off"; onChange: (v: "all" | "on" | "off") => void; dark?: boolean;
}) {
  const T = dark
    ? { surface: C.surfaceAlt, border: C.border, textMute: C.creamMute, text: C.cream }
    : { surface: "#f3f3f0", border: "#e5e5e2", textMute: "#8a8a85", text: "#1a1a18" };
  const opts: { key: "all" | "on" | "off"; label: string; onColor: string }[] = [
    { key: "all", label: "All", onColor: T.text },
    { key: "on", label: "On", onColor: C.green },
    { key: "off", label: "Off", onColor: C.red },
  ];
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: T.textMute }}>{label}</span>
      <div style={{ display: "inline-flex", background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, padding: 2, gap: 2 }}>
        {opts.map((o) => {
          const active = value === o.key;
          return (
            <button
              key={o.key}
              onClick={() => onChange(o.key)}
              style={{
                border: "none",
                borderRadius: 6,
                padding: "4px 10px",
                fontSize: 11,
                fontWeight: 700,
                fontFamily: "inherit",
                cursor: "pointer",
                background: active ? o.onColor + "22" : "transparent",
                color: active ? o.onColor : T.textMute,
                boxShadow: active ? `inset 0 0 0 1px ${o.onColor}66` : "none",
                transition: "all 0.12s",
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
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
  const [suggestions, setSuggestions] = useState<SuggestionEntry[]>([]);
  const [suggestionStatusFilter, setSuggestionStatusFilter] = useState<"active" | "new" | "resolved" | "archived" | "all">("active");
  const [suggestionTypeFilter, setSuggestionTypeFilter] = useState<"all" | "suggestion" | "issue">("all");
  const [suggestionActionId, setSuggestionActionId] = useState<string | null>(null);
  // Accordion — only one ticket's full thread/actions open at a time, so a
  // long list of reports stays scannable instead of everything expanded.
  const [expandedSuggestionId, setExpandedSuggestionId] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Record<string, { username: string | null; displayName: string | null }>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastLoaded, setLastLoaded] = useState<Date | null>(null);
  const [dark, setDark] = useState(true);
  // Which top-level dashboard tab is showing — lets Spin Wheel Results /
  // Raffle / Coin Toss live in their own "Games" tab instead of clogging
  // up the main Overview tab. Purely cosmetic split, no data/logic changes.
  const [mainTab, setMainTab] = useState<"overview" | "games">("overview");
  const [failedPayouts, setFailedPayouts] = useState<FailedPayout[]>([]);
  const [poolDegen, setPoolDegen] = useState<number | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [dismissDrafts, setDismissDrafts] = useState<Record<string, string>>({});
  const [playerSearchQuery, setPlayerSearchQuery] = useState("");
  const [playerNotifFilter, setPlayerNotifFilter] = useState<"all" | "on" | "off">("all");
  const [globalSearchQuery, setGlobalSearchQuery] = useState("");

  // Missing txn-log backfill — dry-run check, then explicit confirm before writing.
  // See app/api/admin-backfill-txn-log/route.ts (GET = dry run, POST = commit).
  const [missingTxns, setMissingTxns] = useState<TxnEntry[] | null>(null); // null = not checked yet
  const [missingTxnsLoading, setMissingTxnsLoading] = useState(false);
  const [backfillingTxns, setBackfillingTxns] = useState(false);

  // Result modal (replaces toast)
  const [modal, setModal] = useState<{ msg: string; type: "success" | "error" } | null>(null);
  const showModal = useCallback((msg: string, type: "success" | "error" = "success") => {
    setModal({ msg, type });
  }, []);
  // keep addToast name so runAction callers don't need changing
  const addToast = showModal;

  // Confirm modal (replaces window.confirm) — set msg + onConfirm, modal
  // renders Cancel/Confirm buttons and calls onConfirm() only if the admin
  // clicks Confirm. danger=true renders the Confirm button in red.
  const [confirmModal, setConfirmModal] = useState<{ msg: string; onConfirm: () => void; danger?: boolean } | null>(null);
  const askConfirm = useCallback((msg: string, onConfirm: () => void, danger: boolean = true) => {
    setConfirmModal({ msg, onConfirm, danger });
  }, []);

  // Prompt modal (replaces window.prompt) — for actions that need a short
  // text reason before proceeding, e.g. voiding a raffle round. Cancel
  // resolves like window.prompt's null; Confirm always calls onConfirm,
  // even with an empty string, and the caller decides the fallback text.
  const [promptModal, setPromptModal] = useState<{ msg: string; onConfirm: (value: string) => void; value: string } | null>(null);
  const askPrompt = useCallback((msg: string, onConfirm: (value: string) => void) => {
    setPromptModal({ msg, onConfirm, value: "" });
  }, []);

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
  const [notifFilter, setNotifFilter] = useState<"all" | "on" | "off">("all");
  const [addedFilter, setAddedFilter] = useState<"all" | "on" | "off">("all");
  const [controlState, setControlState] = useState<any>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [controlLoading, setControlLoading] = useState(false);
  const [controlMsg, setControlMsg] = useState<string | null>(null);
  const [statDrafts, setStatDrafts] = useState({ xp: "", bond: "", glimmer: "", hunger: "", happiness: "" });
  const [accessoryToRevoke, setAccessoryToRevoke] = useState("");
  const [accessoryToUnlock, setAccessoryToUnlock] = useState("");
  const [newReferrerFid, setNewReferrerFid] = useState("");
  const [triggerRealPayout, setTriggerRealPayout] = useState(false);
  const [raffleAdmin, setRaffleAdmin] = useState<any>(null);
  const [raffleAdminLoading, setRaffleAdminLoading] = useState(true);
  const [raffleAdminError, setRaffleAdminError] = useState<string | null>(null);
  const [minigamesAdmin, setMinigamesAdmin] = useState<any>(null);
  const [minigamesAdminLoading, setMinigamesAdminLoading] = useState(true);
  const [minigamesAdminError, setMinigamesAdminError] = useState<string | null>(null);
  const [minigamesConfigDraft, setMinigamesConfigDraft] = useState<Record<string, string>>({});
  const [diceConfigDraft, setDiceConfigDraft] = useState<Record<string, string>>({});
  const [showSeedHistory, setShowSeedHistory] = useState(false);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  // Which config field's "?" hint popover is open, e.g. "cointoss:feePercentOnWin"
  // or "dice:houseEdgePercent" — prefixed so the two config blocks' fields
  // (some share key names, like lossCircuitBreakerDegen) never collide.
  const [openConfigHint, setOpenConfigHint] = useState<string | null>(null);
  // Close the config-hint popover on outside click. Uses `mousedown` (fires
  // before the toggle button's `click`) and only closes when the click lands
  // outside any [data-config-hint] container — so a click on the toggle
  // button itself still reaches its own onClick and toggles normally.
  // No full-screen backdrop element, so clicks elsewhere on the page (tabs,
  // other buttons, scroll) are never swallowed.
  useEffect(() => {
    if (!openConfigHint) return;
    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-config-hint]")) {
        setOpenConfigHint(null);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [openConfigHint]);
  const [cashoutSearch, setCashoutSearch] = useState("");
  const [flipsSearch, setFlipsSearch] = useState("");
  const [playerHistoryQuery, setPlayerHistoryQuery] = useState("");
  const [playerHistoryResults, setPlayerHistoryResults] = useState<CoinTossFlipEntry[] | null>(null);
  const [playerHistoryIdentityKey, setPlayerHistoryIdentityKey] = useState<string | null>(null);
  const [playerHistoryError, setPlayerHistoryError] = useState<string | null>(null);
  const [playerHistoryLoading, setPlayerHistoryLoading] = useState(false);

  // ── Dice Provably Fair / roll-history — own state from Coin Toss's above.
  // Dice's seed history, recent-rolls search, and per-player lookup are all
  // backed by their own KV lists (see lib/minigames.ts), so none of this
  // reuses or overwrites the Coin Toss state block. ─────────────────────────
  const [showDiceSeedHistory, setShowDiceSeedHistory] = useState(false);
  const [rollsSearch, setRollsSearch] = useState("");
  const [playerRollHistoryQuery, setPlayerRollHistoryQuery] = useState("");
  const [playerRollHistoryResults, setPlayerRollHistoryResults] = useState<DiceRollEntry[] | null>(null);
  const [playerRollHistoryIdentityKey, setPlayerRollHistoryIdentityKey] = useState<string | null>(null);
  const [playerRollHistoryError, setPlayerRollHistoryError] = useState<string | null>(null);
  const [playerRollHistoryLoading, setPlayerRollHistoryLoading] = useState(false);
  const [creditFid, setCreditFid] = useState("");
  const [creditWallet, setCreditWallet] = useState("");
  const [creditAmount, setCreditAmount] = useState("");
  const [creditReason, setCreditReason] = useState("");
  const [creditResult, setCreditResult] = useState<string | null>(null);
  const [raffleActionLoading, setRaffleActionLoading] = useState<string | null>(null);
  const [expandedVoidRoundId, setExpandedVoidRoundId] = useState<string | null>(null);
  const [raffleAccessoryInputs, setRaffleAccessoryInputs] = useState<Record<string, string>>({});

  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopiedHash(text);
      setTimeout(() => setCopiedHash((cur) => (cur === text ? null : cur)), 1500);
    });
  }, []);

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

  const resolveFailedPayout = useCallback(async (id: string, action: "retry" | "dismiss", confirmed = false, txHash?: string) => {
    setRetryingId(id);
    try {
      const res = await authedPost("/api/admin/failed-payouts", { id, action, confirmed, txHash });
      if (res.ok) {
        setFailedPayouts((prev) => prev.filter((p) => p.id !== id));
        setDismissDrafts((prev) => { const next = { ...prev }; delete next[id]; return next; });
        addToast(
          action === "retry"
            ? `✓ Payout sent (${res.txHash?.slice(0, 10)}…)`
            : res.backfilled ? "✓ Dismissed — txn log backfilled" : "✓ Dismissed",
          "success"
        );
      } else if (res.requiresConfirmation) {
        addToast(`⚠️ This may already be sent — check Basescan for tx ${res.broadcastTxHash?.slice(0, 10)}…, then click Retry again to confirm`, "error");
        setFailedPayouts((prev) =>
          prev.map((p) => (p.id === id ? { ...p, broadcastTxHash: res.broadcastTxHash } : p))
        );
      } else {
        addToast(`✕ ${res.detail ?? res.reason ?? "Retry failed"}`, "error");
        if (action === "retry") {
          // still failing — refresh the reason/timestamp/hash shown for this record
          setFailedPayouts((prev) =>
            prev.map((p) => (p.id === id ? { ...p, reason: res.detail ?? p.reason, broadcastTxHash: res.broadcastTxHash ?? p.broadcastTxHash, ts: Date.now() } : p))
          );
        }
      }
    } catch (err: any) {
      addToast(`✕ ${err?.message ?? "Retry failed"}`, "error");
    } finally {
      setRetryingId(null);
    }
  }, [authedPost, addToast]);

  // Updates a suggestion/issue's status (seen / resolved / archived) and
  // reflects it locally instead of a full reload, so the list doesn't jump.
  const markSuggestion = useCallback(async (id: string, status: SuggestionEntry["status"]) => {
    setSuggestionActionId(id);
    try {
      const res = await authedPost("/api/admin/suggestions", { id, status });
      if (!res?.ok) {
        addToast(`✕ ${res?.reason ?? "Could not update"}`, "error");
        return;
      }
      setSuggestions((prev) => prev.map((s) => (s.id === id ? { ...s, status } : s)));
      addToast(`✓ Marked ${status}`, "success");
    } catch (err: any) {
      addToast(`✕ ${err?.message ?? "Could not update"}`, "error");
    } finally {
      setSuggestionActionId(null);
    }
  }, [authedPost, addToast]);

  // Reply thread — issue reports only (suggestions stay one-way). Draft text
  // per ticket id so multiple open threads don't clobber each other.
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const sendSuggestionReply = useCallback(async (id: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSuggestionActionId(id);
    try {
      const res = await authedPost("/api/admin/suggestions", { id, reply: trimmed });
      if (!res?.ok) {
        addToast(`✕ ${res?.reason ?? "Could not send reply"}`, "error");
        return;
      }
      setSuggestions((prev) => prev.map((s) => (s.id === id ? res.suggestion : s)));
      setReplyDrafts((prev) => ({ ...prev, [id]: "" }));
      addToast("✓ Reply sent", "success");
    } catch (err: any) {
      addToast(`✕ ${err?.message ?? "Could not send reply"}`, "error");
    } finally {
      setSuggestionActionId(null);
    }
  }, [authedPost, addToast]);

  // Dry-run check — shows what would be backfilled without writing anything.
  const checkMissingTxns = useCallback(async () => {
    setMissingTxnsLoading(true);
    try {
      const res = await authedGet("/api/admin-backfill-txn-log");
      if (res?.error) {
        addToast(`✕ ${res.error}`, "error");
        setMissingTxns(null);
      } else {
        setMissingTxns(res.missing ?? []);
        if ((res.missing ?? []).length === 0) addToast("✓ No missing transactions found.", "success");
      }
    } catch (err: any) {
      addToast(`✕ ${err?.message ?? "Check failed"}`, "error");
      setMissingTxns(null);
    } finally {
      setMissingTxnsLoading(false);
    }
  }, [authedGet, addToast]);

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
      const [debugRes, txnRes, failedRes, suggestionsRes] = await Promise.all([
        authedGet("/api/debug-kv"),
        authedGet("/api/txn-log?all=1"),
        authedGet("/api/admin/failed-payouts"),
        authedGet("/api/admin/suggestions"),
      ]);
      if (debugRes.error === "Unauthorized" || txnRes.error === "Unauthorized") {
        setError("Unauthorized — you may not have access to this dashboard.");
        setUsers([]); setTxns([]); return;
      }
      setUsers(debugRes.users ?? []);
      setWebhookEvents(debugRes.webhookEvents ?? []);
      setTxns(txnRes.log ?? []);
      setFailedPayouts(failedRes?.payouts ?? []);
      setSuggestions(suggestionsRes?.suggestions ?? []);
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

  // Actually writes the missing entries after the admin has reviewed the dry run above.
  const confirmBackfillTxns = useCallback(async () => {
    setBackfillingTxns(true);
    try {
      const res = await authedPost("/api/admin-backfill-txn-log", {});
      if (res?.error) {
        addToast(`✕ ${res.error}`, "error");
      } else {
        addToast(`✓ Backfilled ${res.backfilled ?? 0} transaction${res.backfilled === 1 ? "" : "s"}.`, "success");
        setMissingTxns(null);
        load(); // refresh the main txn log so the new entries show up immediately
      }
    } catch (err: any) {
      addToast(`✕ ${err?.message ?? "Backfill failed"}`, "error");
    } finally {
      setBackfillingTxns(false);
    }
  }, [authedPost, addToast, load]);

  useEffect(() => {
    load();
  }, [load]);

  // ── Raffle admin data — independent of the main load(), same reasoning
  // as the treasury/pool fetch above: a raffle hiccup shouldn't block the
  // rest of the dashboard from loading.
  const loadRaffleAdmin = useCallback(async () => {
    setRaffleAdminLoading(true);
    setRaffleAdminError(null);
    try {
      const res = await authedGet("/api/admin/raffle");
      if (res?.reason === "Unauthorized" || res?.ok === false) {
        setRaffleAdminError(res?.reason ?? "Failed to load raffle data");
        return;
      }
      setRaffleAdmin(res);
    } catch (err: any) {
      setRaffleAdminError(err?.message ?? "Failed to load raffle data");
    } finally {
      setRaffleAdminLoading(false);
    }
  }, [authedGet]);

  useEffect(() => {
    loadRaffleAdmin();
  }, [loadRaffleAdmin]);

  // ── Mini Games (Coin Toss) admin ────────────────────────────────────────
  const loadMinigamesAdmin = useCallback(async () => {
    setMinigamesAdminLoading(true);
    setMinigamesAdminError(null);
    try {
      const res = await authedGet("/api/admin/minigames");
      if (res?.reason === "Unauthorized" || res?.ok === false) {
        setMinigamesAdminError(res?.reason ?? "Failed to load mini-games data");
        return;
      }
      setMinigamesAdmin(res);
      // Seed the editable draft fields from the loaded config, but only on
      // first load / after a save — don't stomp on an in-progress edit if
      // this refires from an unrelated action elsewhere on the page.
      setMinigamesConfigDraft((prev) =>
        Object.keys(prev).length ? prev : Object.fromEntries(Object.entries(res.config ?? {}).map(([k, v]) => [k, String(v)])),
      );
      setDiceConfigDraft((prev) =>
        Object.keys(prev).length ? prev : Object.fromEntries(Object.entries(res.diceConfig ?? {}).map(([k, v]) => [k, String(v)])),
      );
    } catch (err: any) {
      setMinigamesAdminError(err?.message ?? "Failed to load mini-games data");
    } finally {
      setMinigamesAdminLoading(false);
    }
  }, [authedGet]);

  useEffect(() => {
    loadMinigamesAdmin();
  }, [loadMinigamesAdmin]);

  const saveMinigamesConfig = useCallback(async () => {
    setRaffleActionLoading("minigames_config");
    try {
      const patch: Record<string, any> = {};
      for (const [k, v] of Object.entries(minigamesConfigDraft)) {
        if (k === "enabled") continue; // handled by the separate pause/resume toggle
        patch[k] = Number(v);
      }
      const res = await authedPost("/api/admin/minigames", { action: "update_config", ...patch });
      if (res?.ok) {
        addToast("✓ Coin Toss config saved.", "success");
        setMinigamesConfigDraft({});
        loadMinigamesAdmin();
      } else {
        addToast(`✕ ${res?.reason ?? "Save failed"}`, "error");
      }
    } catch (err: any) {
      addToast(`✕ ${err?.message ?? "Save failed"}`, "error");
    } finally {
      setRaffleActionLoading(null);
    }
  }, [authedPost, addToast, minigamesConfigDraft, loadMinigamesAdmin]);

  const rotateMinigamesSeed = useCallback(() => {
    askConfirm("Rotate the active provably-fair seed now? The current seed's raw value will be revealed into seed history, and a fresh seed will back all flips from here on.", async () => {
      setRaffleActionLoading("minigames_rotate_seed");
      try {
        const res = await authedPost("/api/admin/minigames", { action: "rotate_seed" });
        if (res?.ok) {
          addToast("✓ Seed rotated — previous seed revealed to history.", "success");
          loadMinigamesAdmin();
        } else {
          addToast(`✕ ${res?.reason ?? "Rotate failed"}`, "error");
        }
      } catch (err: any) {
        addToast(`✕ ${err?.message ?? "Rotate failed"}`, "error");
      } finally {
        setRaffleActionLoading(null);
      }
    });
  }, [askConfirm, authedPost, addToast, loadMinigamesAdmin]);

  const backfillMinigamesTotals = useCallback(() => {
    askConfirm("Seed permanent per-player Coin Toss totals from the current flip log? Only needed once, right after this update ships — safe to re-run, but pointless after the first time.", async () => {
      setRaffleActionLoading("minigames_backfill_totals");
      try {
        const res = await authedPost("/api/admin/minigames", { action: "backfill_cointoss_totals" });
        if (res?.ok) {
          addToast(`✓ Seeded totals for ${res.identitiesSeeded} player(s) from ${res.flipsProcessed} flip(s).`, "success");
          loadMinigamesAdmin();
        } else {
          addToast(`✕ ${res?.reason ?? "Backfill failed"}`, "error");
        }
      } catch (err: any) {
        addToast(`✕ ${err?.message ?? "Backfill failed"}`, "error");
      } finally {
        setRaffleActionLoading(null);
      }
    }, false);
  }, [askConfirm, authedPost, addToast, loadMinigamesAdmin]);

  const purgeMinigamesFlipHistory = useCallback((identityKey: string) => {
    askConfirm(`Clear Coin Toss WIN/LOSS FLIP HISTORY for ${identityKey}?\n\nThis removes their flip records, totals, and Player Stats row. Their balance, deposits, cash-outs, and credit history are NOT touched. This can't be undone.`, async () => {
      setRaffleActionLoading(`minigames_purge_${identityKey}`);
      try {
        const res = await authedPost("/api/admin/minigames", { action: "purge_cointoss_flip_history", identityKey });
        if (res?.ok) {
          addToast(`✓ Cleared ${res.flipsRemoved} flip(s) for ${identityKey}.`, "success");
          loadMinigamesAdmin();
        } else {
          addToast(`✕ ${res?.reason ?? "Purge failed"}`, "error");
        }
      } catch (err: any) {
        addToast(`✕ ${err?.message ?? "Purge failed"}`, "error");
      } finally {
        setRaffleActionLoading(null);
      }
    });
  }, [askConfirm, authedPost, addToast, loadMinigamesAdmin]);

  // ── Mini Games (Dice) admin — shares Coin Toss's balance/cashout/deposit
  // system entirely; only config, seed rotation, and roll-history purge are
  // Dice-specific. ────────────────────────────────────────────────────────
  const saveDiceConfig = useCallback(async () => {
    setRaffleActionLoading("dice_config");
    try {
      const patch: Record<string, any> = {};
      for (const [k, v] of Object.entries(diceConfigDraft)) {
        if (k === "enabled") continue; // handled by the separate pause/resume toggle
        patch[k] = Number(v);
      }
      const res = await authedPost("/api/admin/minigames", { action: "update_dice_config", ...patch });
      if (res?.ok) {
        addToast("✓ Dice config saved.", "success");
        setDiceConfigDraft({});
        loadMinigamesAdmin();
      } else {
        addToast(`✕ ${res?.reason ?? "Save failed"}`, "error");
      }
    } catch (err: any) {
      addToast(`✕ ${err?.message ?? "Save failed"}`, "error");
    } finally {
      setRaffleActionLoading(null);
    }
  }, [authedPost, addToast, diceConfigDraft, loadMinigamesAdmin]);

  const toggleDiceEnabled = useCallback(async () => {
    setRaffleActionLoading("dice_toggle");
    try {
      const res = await authedPost("/api/admin/minigames", { action: "toggle_dice_enabled" });
      if (res?.ok) {
        addToast(res.enabled ? "✓ Dice resumed." : "✓ Dice paused.", "success");
        setDiceConfigDraft({});
        loadMinigamesAdmin();
      } else {
        addToast(`✕ ${res?.reason ?? "Toggle failed"}`, "error");
      }
    } catch (err: any) {
      addToast(`✕ ${err?.message ?? "Toggle failed"}`, "error");
    } finally {
      setRaffleActionLoading(null);
    }
  }, [authedPost, addToast, loadMinigamesAdmin]);

  const rotateDiceSeed = useCallback(() => {
    askConfirm("Rotate the active Dice provably-fair seed now? The current seed's raw value will be revealed into seed history, and a fresh seed will back all rolls from here on.", async () => {
      setRaffleActionLoading("dice_rotate_seed");
      try {
        const res = await authedPost("/api/admin/minigames", { action: "rotate_dice_seed" });
        if (res?.ok) {
          addToast("✓ Dice seed rotated — previous seed revealed to history.", "success");
          loadMinigamesAdmin();
        } else {
          addToast(`✕ ${res?.reason ?? "Rotate failed"}`, "error");
        }
      } catch (err: any) {
        addToast(`✕ ${err?.message ?? "Rotate failed"}`, "error");
      } finally {
        setRaffleActionLoading(null);
      }
    });
  }, [askConfirm, authedPost, addToast, loadMinigamesAdmin]);

  const purgeDiceRollHistory = useCallback((identityKey: string) => {
    askConfirm(`Clear Dice WIN/LOSS ROLL HISTORY for ${identityKey}?\n\nThis removes their roll records, totals, and Player Stats row. Their balance, deposits, cash-outs, and credit history are NOT touched (those are shared with Coin Toss). This can't be undone.`, async () => {
      setRaffleActionLoading(`dice_purge_${identityKey}`);
      try {
        const res = await authedPost("/api/admin/minigames", { action: "purge_dice_roll_history", identityKey });
        if (res?.ok) {
          addToast(`✓ Cleared ${res.rollsRemoved} roll(s) for ${identityKey}.`, "success");
          loadMinigamesAdmin();
        } else {
          addToast(`✕ ${res?.reason ?? "Purge failed"}`, "error");
        }
      } catch (err: any) {
        addToast(`✕ ${err?.message ?? "Purge failed"}`, "error");
      } finally {
        setRaffleActionLoading(null);
      }
    });
  }, [askConfirm, authedPost, addToast, loadMinigamesAdmin]);

  const lookupPlayerFlipHistory = useCallback(async () => {
    const raw = playerHistoryQuery.trim();
    if (!raw) return;
    setPlayerHistoryLoading(true);
    setPlayerHistoryError(null);
    setPlayerHistoryResults(null);
    setPlayerHistoryIdentityKey(null);
    try {
      // Accept either an fid (numeric) or a wallet address in the same box —
      // mirrors the fid/wallet dual-input pattern used by Manual Credit below.
      const isNumeric = /^\d+$/.test(raw);
      const body = isNumeric ? { action: "lookup_flip_history", fid: raw } : { action: "lookup_flip_history", wallet: raw };
      const res = await authedPost("/api/admin/minigames", body);
      if (res?.ok) {
        setPlayerHistoryResults(res.flips ?? []);
        setPlayerHistoryIdentityKey(res.identityKey ?? null);
      } else {
        setPlayerHistoryError(res?.reason ?? "Lookup failed");
      }
    } catch (err: any) {
      setPlayerHistoryError(err?.message ?? "Lookup failed");
    } finally {
      setPlayerHistoryLoading(false);
    }
  }, [authedPost, playerHistoryQuery]);

  const lookupPlayerRollHistory = useCallback(async () => {
    const raw = playerRollHistoryQuery.trim();
    if (!raw) return;
    setPlayerRollHistoryLoading(true);
    setPlayerRollHistoryError(null);
    setPlayerRollHistoryResults(null);
    setPlayerRollHistoryIdentityKey(null);
    try {
      // Same fid-or-wallet dual input as lookupPlayerFlipHistory above, but
      // hits lookup_dice_history — its own action, its own per-identity
      // roll list (getDiceRollsForIdentity), not the Coin Toss flip list.
      const isNumeric = /^\d+$/.test(raw);
      const body = isNumeric ? { action: "lookup_dice_history", fid: raw } : { action: "lookup_dice_history", wallet: raw };
      const res = await authedPost("/api/admin/minigames", body);
      if (res?.ok) {
        setPlayerRollHistoryResults(res.rolls ?? []);
        setPlayerRollHistoryIdentityKey(res.identityKey ?? null);
      } else {
        setPlayerRollHistoryError(res?.reason ?? "Lookup failed");
      }
    } catch (err: any) {
      setPlayerRollHistoryError(err?.message ?? "Lookup failed");
    } finally {
      setPlayerRollHistoryLoading(false);
    }
  }, [authedPost, playerRollHistoryQuery]);

  const toggleMinigamesEnabled = useCallback(async () => {
    setRaffleActionLoading("minigames_toggle");
    try {
      const res = await authedPost("/api/admin/minigames", { action: "toggle_enabled" });
      if (res?.ok) {
        addToast(res.enabled ? "✓ Coin Toss resumed." : "✓ Coin Toss paused.", "success");
        setMinigamesConfigDraft({});
        loadMinigamesAdmin();
      } else {
        addToast(`✕ ${res?.reason ?? "Toggle failed"}`, "error");
      }
    } catch (err: any) {
      addToast(`✕ ${err?.message ?? "Toggle failed"}`, "error");
    } finally {
      setRaffleActionLoading(null);
    }
  }, [authedPost, addToast, loadMinigamesAdmin]);

  const fulfillMinigamesCashout = useCallback(async (cashoutId: string) => {
    const loadingKey = `cashout_${cashoutId}`;
    setRaffleActionLoading(loadingKey);
    try {
      const res = await authedPost("/api/admin/minigames", { action: "fulfill_cashout", cashoutId });
      if (res?.ok) {
        addToast(`✓ Sent (tx ${String(res.txHash ?? "").slice(0, 10)}…)`, "success");
        loadMinigamesAdmin();
      } else {
        addToast(`✕ ${res?.reason ?? "Cash-out failed"}`, "error");
      }
    } catch (err: any) {
      addToast(`✕ ${err?.message ?? "Cash-out failed"}`, "error");
    } finally {
      setRaffleActionLoading(null);
    }
  }, [authedPost, addToast, loadMinigamesAdmin]);

  const cancelMinigamesCashout = useCallback(async (cashoutId: string) => {
    const loadingKey = `cashout_cancel_${cashoutId}`;
    setRaffleActionLoading(loadingKey);
    try {
      const res = await authedPost("/api/admin/minigames", { action: "cancel_cashout", cashoutId });
      if (res?.ok) {
        addToast(`✓ Cancelled — refunded, balance now ${res.newBalance} DEGEN.`, "success");
        loadMinigamesAdmin();
      } else {
        addToast(`✕ ${res?.reason ?? "Cancel failed"}`, "error");
      }
    } catch (err: any) {
      addToast(`✕ ${err?.message ?? "Cancel failed"}`, "error");
    } finally {
      setRaffleActionLoading(null);
    }
  }, [authedPost, addToast, loadMinigamesAdmin]);

  const cancelMinigamesCredit = useCallback(async (creditId: string) => {
    const loadingKey = `credit_cancel_${creditId}`;
    setRaffleActionLoading(loadingKey);
    try {
      const res = await authedPost("/api/admin/minigames", { action: "cancel_credit", creditId });
      if (res?.ok) {
        addToast(`✓ Cancelled — balance now ${res.newBalance} DEGEN.`, "success");
        loadMinigamesAdmin();
      } else {
        addToast(`✕ ${res?.reason ?? "Cancel failed"}`, "error");
      }
    } catch (err: any) {
      addToast(`✕ ${err?.message ?? "Cancel failed"}`, "error");
    } finally {
      setRaffleActionLoading(null);
    }
  }, [authedPost, addToast, loadMinigamesAdmin]);

  const creditPlayerBalance = useCallback(async () => {
    if (!creditFid.trim() && !creditWallet.trim()) {
      addToast("✕ Enter an FID or wallet address.", "error");
      return;
    }
    const amount = Number(creditAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      addToast("✕ Enter a valid amount.", "error");
      return;
    }
    setRaffleActionLoading("minigames_credit");
    setCreditResult(null);
    try {
      const res = await authedPost("/api/admin/minigames", {
        action: "credit_balance",
        fid: creditFid.trim() || undefined,
        wallet: creditWallet.trim() || undefined,
        amountDegen: amount,
        reason: creditReason.trim() || undefined,
      });
      if (res?.ok) {
        addToast(`✓ Credited ${amount} DEGEN — new balance ${res.newBalance}.`, "success");
        setCreditResult(`${res.identityKey} → ${res.newBalance} DEGEN`);
        setCreditAmount("");
        setCreditReason("");
        loadMinigamesAdmin();
      } else {
        addToast(`✕ ${res?.reason ?? "Credit failed"}`, "error");
      }
    } catch (err: any) {
      addToast(`✕ ${err?.message ?? "Credit failed"}`, "error");
    } finally {
      setRaffleActionLoading(null);
    }
  }, [authedPost, addToast, creditFid, creditWallet, creditAmount, creditReason, loadMinigamesAdmin]);

  // Runs the same reveal→lock→open sequence the Sunday cron does, out of
  // schedule. Safe to click any time — each step is a no-op if there's
  // nothing for it to do.
  const forceDrawRaffle = useCallback(() => {
    askConfirm("Force a raffle draw right now? This reveals any round awaiting reveal, locks the current open round, and opens a new one.", async () => {
      setRaffleActionLoading("force_draw");
      try {
        const res = await authedPost("/api/admin/raffle", { action: "force_draw" });
        if (res?.ok) {
          addToast("✓ Raffle draw forced.", "success");
          loadRaffleAdmin();
        } else {
          addToast(`✕ ${res?.reason ?? "Force draw failed"}`, "error");
        }
      } catch (err: any) {
        addToast(`✕ ${err?.message ?? "Force draw failed"}`, "error");
      } finally {
        setRaffleActionLoading(null);
      }
    });
  }, [askConfirm, authedPost, addToast, loadRaffleAdmin]);

  // Reveals a stuck "awaiting reveal" round WITHOUT locking/opening the
  // currently-open round — safe to click repeatedly while waiting on the
  // target block, unlike Force Draw Now which also force-locks whatever
  // round is open right now.
  const forceRevealOnly = useCallback(async () => {
    setRaffleActionLoading("force_reveal_only");
    try {
      const res = await authedPost("/api/admin/raffle", { action: "force_reveal_only" });
      if (res?.ok && res.revealed) {
        addToast("✓ Round revealed.", "success");
      } else if (res?.ok) {
        addToast(`ℹ ${res?.reason ?? "Not revealed yet"}${res?.currentBlock != null ? ` (block ${res.currentBlock}/${res.targetBlock})` : ""}`, "error");
      } else {
        addToast(`✕ ${res?.reason ?? "Force reveal failed"}`, "error");
      }
      loadRaffleAdmin();
    } catch (err: any) {
      addToast(`✕ ${err?.message ?? "Force reveal failed"}`, "error");
    } finally {
      setRaffleActionLoading(null);
    }
  }, [authedPost, addToast, loadRaffleAdmin]);

  // Voids an in-flight round without drawing a winner. Does not auto-refund
  // entrants — same philosophy as the rest of the admin toolkit.
  const voidRaffleRound = useCallback((roundId: string) => {
    askPrompt(`Void round ${roundId}? Tickets are NOT auto-refunded. Enter a reason:`, async (reason) => {
      setRaffleActionLoading(`void_${roundId}`);
      try {
        const res = await authedPost("/api/admin/raffle", { action: "void_round", roundId, reason: reason || "voided by admin" });
        if (res?.ok) {
          addToast(`✓ Round ${roundId} voided.`, "success");
          loadRaffleAdmin();
        } else {
          addToast(`✕ ${res?.reason ?? "Void failed"}`, "error");
        }
      } catch (err: any) {
        addToast(`✕ ${err?.message ?? "Void failed"}`, "error");
      } finally {
        setRaffleActionLoading(null);
      }
    });
  }, [askPrompt, authedPost, addToast, loadRaffleAdmin]);

  // Refunds one entrant of a voided round — sends real USDC out of the
  // treasury (same env-configured wallet the referral DEGEN payouts use).
  // Idempotent server-side via round.refunds, so a repeated click after a
  // refresh just comes back "already refunded" instead of double-paying.
  const refundRaffleEntrant = useCallback((roundId: string, identityKey: string, amountMicroUsdc: number) => {
    const amountUsd = (amountMicroUsdc / 1_000_000).toFixed(2);
    askConfirm(`Refund $${amountUsd} USDC to ${identityKey}? This sends real money from the treasury.`, async () => {
      const loadingKey = `refund_${roundId}_${identityKey}`;
      setRaffleActionLoading(loadingKey);
      try {
        const res = await authedPost("/api/admin/raffle", { action: "refund_entrant", roundId, identityKey });
        if (res?.ok) {
          addToast(`✓ Refunded $${amountUsd} to ${identityKey} (tx ${String(res.txHash ?? "").slice(0, 10)}…)`, "success");
          loadRaffleAdmin();
        } else {
          addToast(`✕ ${res?.reason ?? "Refund failed"}`, "error");
        }
      } catch (err: any) {
        addToast(`✕ ${err?.message ?? "Refund failed"}`, "error");
      } finally {
        setRaffleActionLoading(null);
      }
    });
  }, [askConfirm, authedPost, addToast, loadRaffleAdmin]);

  // Refunds every entrant of a voided round, one USDC send each. Each
  // entrant refunds independently server-side — a single bad wallet lookup
  // or RPC hiccup doesn't block or roll back the others, so check the
  // partial-failure toast below and retry just the failed ones individually.
  const refundRaffleAll = useCallback((roundId: string, entrantCount: number) => {
    askConfirm(`Refund ALL ${entrantCount} entrant(s) in round ${roundId}? This sends real USDC from the treasury — one transaction per entrant.`, async () => {
      const loadingKey = `refundall_${roundId}`;
      setRaffleActionLoading(loadingKey);
      try {
        const res = await authedPost("/api/admin/raffle", { action: "refund_all", roundId });
        if (res?.ok) {
          const results = res.results ?? [];
          const okCount = results.filter((r: any) => r.ok).length;
          const failCount = results.length - okCount;
          addToast(
            failCount > 0
              ? `✓ Refunded ${okCount}/${results.length} — ${failCount} failed (see console + failed-refunds log)`
              : `✓ Refunded all ${okCount} entrant(s).`,
            failCount > 0 ? "error" : "success",
          );
          if (failCount > 0) console.error("[raffle] refund_all partial failures:", results.filter((r: any) => !r.ok));
          loadRaffleAdmin();
        } else {
          addToast(`✕ ${res?.reason ?? "Refund all failed"}`, "error");
        }
      } catch (err: any) {
        addToast(`✕ ${err?.message ?? "Refund all failed"}`, "error");
      } finally {
        setRaffleActionLoading(null);
      }
    });
  }, [askConfirm, authedPost, addToast, loadRaffleAdmin]);

  // Picks/changes the open round's prize kind. Server-side enforces
  // "only while open" — setRoundPrizeKind() throws once the round locks, so
  // a stale dropdown click after a lock can't retroactively change what's
  // already been auto-picked.
  const setRafflePrizeKind = useCallback(async (roundId: string, kind: string) => {
    setRaffleActionLoading(`prizekind_${roundId}`);
    try {
      const res = await authedPost("/api/admin/raffle", { action: "set_prize_kind", roundId, prizeKind: kind });
      if (res?.ok) {
        addToast(`✓ Prize set to ${kind.toUpperCase()} for round ${roundId}.`, "success");
        loadRaffleAdmin();
      } else {
        addToast(`✕ ${res?.reason ?? "Could not set prize"}`, "error");
      }
    } catch (err: any) {
      addToast(`✕ ${err?.message ?? "Could not set prize"}`, "error");
    } finally {
      setRaffleActionLoading(null);
    }
  }, [authedPost, addToast, loadRaffleAdmin]);

  // Sends a round's pending DEGEN prize. System builds and broadcasts the
  // transfer itself (same treasury/sendDegen as referral payouts) — admin
  // only clicks the button, no amount or tx hash entry.
  const sendDegenPrize = useCallback((roundId: string, amountDegen: number, winnerKey: string) => {
    askConfirm(`Send ${amountDegen} DEGEN to ${winnerKey}? This sends real tokens from the treasury.`, async () => {
      const loadingKey = `degenprize_${roundId}`;
      setRaffleActionLoading(loadingKey);
      try {
        const res = await authedPost("/api/admin/raffle", { action: "send_degen_prize", roundId });
        if (res?.ok) {
          addToast(`✓ Sent ${amountDegen} DEGEN (tx ${String(res.txHash ?? "").slice(0, 10)}…)`, "success");
          loadRaffleAdmin();
        } else {
          addToast(`✕ ${res?.reason ?? "DEGEN payout failed"}`, "error");
        }
      } catch (err: any) {
        addToast(`✕ ${err?.message ?? "DEGEN payout failed"}`, "error");
      } finally {
        setRaffleActionLoading(null);
      }
    });
  }, [askConfirm, authedPost, addToast, loadRaffleAdmin]);

  // Grants a round's pending accessory prize — admin types/picks the
  // accessory id, writes straight into the winner's closet.
  const grantRaffleAccessory = useCallback(async (roundId: string, accessoryId: string) => {
    if (!accessoryId.trim()) {
      addToast("✕ Enter an accessory id first.", "error");
      return;
    }
    const loadingKey = `accessoryprize_${roundId}`;
    setRaffleActionLoading(loadingKey);
    try {
      const res = await authedPost("/api/admin/raffle", { action: "grant_accessory_prize", roundId, accessoryId: accessoryId.trim() });
      if (res?.ok) {
        addToast(`✓ Granted accessory "${accessoryId.trim()}".`, "success");
        loadRaffleAdmin();
      } else {
        addToast(`✕ ${res?.reason ?? "Accessory grant failed"}`, "error");
      }
    } catch (err: any) {
      addToast(`✕ ${err?.message ?? "Accessory grant failed"}`, "error");
    } finally {
      setRaffleActionLoading(null);
    }
  }, [authedPost, addToast, loadRaffleAdmin]);


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

  const sortedTxns = [...txns].sort((a, b) => b.ts - a.ts).slice(0, 500);
  const maxXp = Math.max(1, ...users.map((u) => u.xp || 0));
  const maxCheckins = Math.max(1, ...users.map((u) => u.totalCheckIns || 0));
  const realUsers = users.filter((u) => (u.xp || 0) > 0 || (u.totalCheckIns || 0) > 0);
  const ghostUsers = users.filter((u) => !((u.xp || 0) > 0 || (u.totalCheckIns || 0) > 0));

  // ── Spin Wheel results ──────────────────────────────────────────────────
  // Pulled from the full `txns` list (not the 500-row-capped sortedTxns)
  // so a busy day of other activity can never push wheel spins out of view.
  // wheelReward on each entry is the human-readable label logTransaction
  // sent (e.g. "You won: +1 XP!", "Rare Accessory: Gold Crown!"), not a raw
  // segment id — classifyWheelReward buckets it by substring for the
  // breakdown cards below.
  function classifyWheelReward(label: string): "rare" | "freecheckin" | "streaksave" | "xp" {
    if (label.includes("Rare Accessory")) return "rare";
    if (label.includes("Free Check-in")) return "freecheckin";
    if (label.includes("Streak Save")) return "streaksave";
    return "xp";
  }
  const wheelSpinTxns = [...txns].filter((t) => t.type === "wheel_spin").sort((a, b) => b.ts - a.ts);
  const wheelBreakdown = { rare: 0, freecheckin: 0, streaksave: 0, xp: 0 };
  for (const t of wheelSpinTxns) wheelBreakdown[classifyWheelReward(t.wheelReward ?? "")]++;

  // Base App wallet-only users have fid values like "wallet:0xabc..." which are
  // full addresses and blow out the fixed-width layout in Player Progress.
  // Shorten to "wallet:0x1233....89893" for display only — lookups/manage-user
  // actions still use the untouched full u.fid value.
  const displayFid = useCallback((fid: number | string): string => {
    const fidStr = String(fid);
    if (fidStr.startsWith("wallet:")) {
      const addr = fidStr.slice("wallet:".length);
      if (addr.length > 15) {
        return `wallet:${addr.slice(0, 6)}....${addr.slice(-5)}`;
      }
      return fidStr;
    }
    return fidStr;
  }, []);

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

  const isNotifBothOff = (u: DebugUser) => !u.hasAddedApp && !u.hasNotifToken;
  const matchesNotifFilter = (u: DebugUser) =>
    playerNotifFilter === "all" ? true : playerNotifFilter === "off" ? isNotifBothOff(u) : !isNotifBothOff(u);

  const filteredRealUsers = realUsers.filter(playerMatchesSearch).filter(matchesNotifFilter);
  const filteredGhostUsers = ghostUsers.filter(playerMatchesSearch).filter(matchesNotifFilter);

  const filteredSortedTxns = sortedTxns.filter((t) => globalMatchesFid(t.fid) || globalMatchesFid(t.toFid ?? ""));
  const filteredWheelSpinTxns = wheelSpinTxns.filter((t) => globalMatchesFid(t.fid));
  const filteredWebhookEvents = webhookEvents.filter((e) => globalMatchesFid(e.fid));

  // Suggestions & Issues — "active" (the default) hides archived so old,
  // handled items don't pile up in view; switch to "all" to see everything.
  const newSuggestionCount = suggestions.filter((s) => s.status === "new").length;
  const suggestionsPanelRef = useRef<HTMLDivElement | null>(null);

  // Surface unread suggestions/issues in the browser tab title too — so you
  // notice new ones even if the dashboard tab is just sitting in the
  // background, without needing to scroll down to the panel to check.
  useEffect(() => {
    const base = "Grub Admin";
    document.title = newSuggestionCount > 0 ? `(${newSuggestionCount}) ${base}` : base;
    return () => { document.title = base; };
  }, [newSuggestionCount]);
  const sortedSuggestions = [...suggestions].sort((a, b) => b.ts - a.ts);
  // Counts how many non-archived entries share the same identity, so a
  // repeat reporter is visible at a glance in the list below.
  const identityActiveCounts = suggestions.reduce<Record<string, number>>((acc, s) => {
    if (s.status !== "archived") acc[s.identity] = (acc[s.identity] ?? 0) + 1;
    return acc;
  }, {});
  const filteredSuggestions = sortedSuggestions
    .filter((s) => {
      if (suggestionStatusFilter === "all") return true;
      // "Active" = still needs attention — excludes both resolved and
      // archived so closed-out tickets don't linger in the default view.
      if (suggestionStatusFilter === "active") return s.status !== "archived" && s.status !== "resolved";
      return s.status === suggestionStatusFilter;
    })
    .filter((s) => suggestionTypeFilter === "all" || s.type === suggestionTypeFilter)
    .filter((s) => globalMatchesFid(s.fid ?? s.wallet ?? s.identity));
  const filteredReferrers = referrers.filter((u) => globalMatchesFid(u.fid));
  const notifStatusUsers = [...users].sort((a, b) => {
    const aTime = a.lastVisit && a.lastVisit !== "unknown" ? new Date(a.lastVisit).getTime() : 0;
    const bTime = b.lastVisit && b.lastVisit !== "unknown" ? new Date(b.lastVisit).getTime() : 0;
    return bTime - aTime;
  });
  const addedButNotifOffCount = users.filter((u) => u.hasAddedApp && !u.hasNotifToken).length;

  const notifStatusQuery = userSearch.trim().toLowerCase();
  let notifStatusFiltered = notifStatusQuery
    ? notifStatusUsers.filter((u) => {
        const uname = profiles[String(u.fid)]?.username?.toLowerCase() ?? "";
        return String(u.fid).includes(notifStatusQuery) || uname.includes(notifStatusQuery.replace(/^@/, ""));
      })
    : notifStatusUsers.filter((u) => globalMatchesFid(u.fid));
  if (notifFilter !== "all") {
    notifStatusFiltered = notifStatusFiltered.filter((u) => (notifFilter === "on" ? !!u.hasNotifToken : !u.hasNotifToken));
  }
  if (addedFilter !== "all") {
    notifStatusFiltered = notifStatusFiltered.filter((u) => (addedFilter === "on" ? !!u.hasAddedApp : !u.hasAddedApp));
  }
  const notifStatusFilterActive = notifFilter !== "all" || addedFilter !== "all" || !!userSearch.trim() || !!globalSearchQuery;

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
              borderRadius: 10,
              padding: "12px 14px",
              width: "max-content",
              maxWidth: "88vw",
              boxShadow: `0 8px 40px rgba(0,0,0,0.35), 0 0 0 1px ${modal.type === "success" ? C.green : C.red}22`,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <span
                style={{
                  flexShrink: 0,
                  width: 18, height: 18, borderRadius: "50%",
                  background: modal.type === "success" ? C.green : C.red,
                  color: modal.type === "success" ? "#001a0d" : "#fff",
                  fontSize: 11, fontWeight: 900, lineHeight: "18px", textAlign: "center",
                }}
              >
                {modal.type === "success" ? "✓" : "✕"}
              </span>
              <p style={{ fontSize: 13, fontWeight: 600, color: T.cream, margin: 0, lineHeight: 1.4, whiteSpace: "nowrap" }}>{modal.msg.replace(/^[✓✕]\s*/, "")}</p>
            </div>
            <div style={{ display: "flex", justifyContent: "center" }}>
              <button
                onClick={() => setModal(null)}
                style={{
                  background: modal.type === "success" ? C.green : C.red,
                  border: "none", borderRadius: 6,
                  color: modal.type === "success" ? "#001a0d" : "#fff",
                  padding: "5px 18px", fontSize: 12, fontWeight: 700,
                  cursor: "pointer", fontFamily: "inherit",
                }}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Confirm Modal (replaces window.confirm) ── */}
      {confirmModal && (
        <div
          onClick={() => setConfirmModal(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 2100,
            background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: T.surface,
              border: `1px solid ${confirmModal.danger === false ? C.green + "66" : C.red + "66"}`,
              borderRadius: 10,
              padding: "14px 16px",
              maxWidth: 320,
              width: "88vw",
              boxShadow: `0 8px 40px rgba(0,0,0,0.35), 0 0 0 1px ${confirmModal.danger === false ? C.green : C.red}22`,
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 14 }}>
              <span style={{ flexShrink: 0, fontSize: 15, lineHeight: "18px" }}>{confirmModal.danger === false ? "❓" : "⚠️"}</span>
              <p style={{ fontSize: 13, fontWeight: 600, color: T.cream, margin: 0, lineHeight: 1.4, whiteSpace: "pre-line", overflowWrap: "anywhere", wordBreak: "break-word", minWidth: 0 }}>{confirmModal.msg}</p>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => setConfirmModal(null)}
                style={{
                  background: "transparent",
                  border: `1px solid ${T.creamDim}77`,
                  borderRadius: 6,
                  color: T.cream,
                  padding: "5px 16px", fontSize: 12, fontWeight: 700,
                  cursor: "pointer", fontFamily: "inherit",
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const fn = confirmModal.onConfirm;
                  setConfirmModal(null);
                  fn();
                }}
                style={{
                  background: confirmModal.danger === false ? C.green : C.red,
                  border: "none", borderRadius: 6,
                  color: confirmModal.danger === false ? "#001a0d" : "#fff",
                  padding: "5px 16px", fontSize: 12, fontWeight: 700,
                  cursor: "pointer", fontFamily: "inherit",
                }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Prompt Modal (replaces window.prompt) ── */}
      {promptModal && (
        <div
          onClick={() => setPromptModal(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 2100,
            background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: T.surface,
              border: `1px solid ${C.red}66`,
              borderRadius: 10,
              padding: "14px 16px",
              maxWidth: 320,
              width: "88vw",
              boxShadow: `0 8px 40px rgba(0,0,0,0.35), 0 0 0 1px ${C.red}22`,
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 10 }}>
              <span style={{ flexShrink: 0, fontSize: 15, lineHeight: "18px" }}>⚠️</span>
              <p style={{ fontSize: 13, fontWeight: 600, color: T.cream, margin: 0, lineHeight: 1.4, whiteSpace: "pre-line" }}>{promptModal.msg}</p>
            </div>
            <input
              autoFocus
              value={promptModal.value}
              onChange={(e) => setPromptModal((m) => (m ? { ...m, value: e.target.value } : m))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const fn = promptModal.onConfirm;
                  const val = promptModal.value;
                  setPromptModal(null);
                  fn(val);
                } else if (e.key === "Escape") {
                  setPromptModal(null);
                }
              }}
              placeholder="Enter a reason…"
              style={{
                width: "100%", boxSizing: "border-box",
                background: T.surfaceAlt, border: `1px solid ${T.creamDim}55`, borderRadius: 6,
                color: T.cream, padding: "7px 10px", fontSize: 12, fontFamily: "inherit",
                marginBottom: 12, outline: "none",
              }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => setPromptModal(null)}
                style={{
                  background: "transparent",
                  border: `1px solid ${T.creamDim}77`,
                  borderRadius: 6,
                  color: T.cream,
                  padding: "5px 16px", fontSize: 12, fontWeight: 700,
                  cursor: "pointer", fontFamily: "inherit",
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const fn = promptModal.onConfirm;
                  const val = promptModal.value;
                  setPromptModal(null);
                  fn(val);
                }}
                style={{
                  background: C.red,
                  border: "none", borderRadius: 6,
                  color: "#fff",
                  padding: "5px 16px", fontSize: 12, fontWeight: 700,
                  cursor: "pointer", fontFamily: "inherit",
                }}
              >
                Confirm
              </button>
            </div>
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
          {/* Unread Suggestions/Issues badge — jumps straight to the panel
              and switches its filter to "new" so you land right on the
              unread items instead of the default active-minus-archived view. */}
          {newSuggestionCount > 0 && (
            <button
              onClick={() => {
                setSuggestionStatusFilter("new");
                suggestionsPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              title="Jump to new suggestions & issues"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: C.redDim,
                border: `1px solid ${C.red}66`,
                borderRadius: 20,
                color: C.red,
                padding: "5px 12px",
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              💬 {newSuggestionCount} new
            </button>
          )}
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

        {/* ── Main dashboard tabs ── */}
        <div style={{ display: "flex", gap: 8, marginBottom: "1.25rem", borderBottom: `1px solid ${T.border}` }}>
          {([
            { key: "overview", label: "Overview" },
            { key: "games", label: "🎮 Games" },
          ] as const).map((t) => (
            <button
              key={t.key}
              onClick={() => setMainTab(t.key)}
              style={{
                background: "transparent",
                border: "none",
                borderBottom: `2px solid ${mainTab === t.key ? C.amberGlow : "transparent"}`,
                color: mainTab === t.key ? T.cream : T.textMute,
                fontWeight: mainTab === t.key ? 800 : 600,
                fontSize: 13,
                padding: "8px 4px",
                marginBottom: -1,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Overview tab content, part 1 (Error banner through Missing
            Transactions) — Spin Wheel Results / Raffle / Coin Toss now live
            in the Games tab below, so Missing Transactions flows straight
            into the Transaction Log again. display:"contents" keeps this
            purely cosmetic — no layout/box changes when visible. ── */}
        <div style={{ display: mainTab === "overview" ? "contents" : "none" }}>
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
                  display: "flex", flexDirection: "column", gap: 4,
                  padding: "8px 10px", borderRadius: 8, background: dark ? "#1a0a0a" : "#fff5f5",
                  fontSize: 12,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <span style={{ fontFamily: "monospace", color: T.cream, fontWeight: 600 }}>
                      {p.amountDegen} DEGEN → fid {p.fid}
                    </span>
                    <span style={{ color: T.textMute }}>({p.type.replace("_", " ")}, triggered by fid {p.toFid})</span>
                    <span style={{ color: C.red, fontStyle: "italic" }}>{p.reason}</span>
                    <span style={{ color: T.textMute, marginLeft: "auto" }}>{timeAgo(p.ts)}</span>
                    <Btn
                      onClick={() => resolveFailedPayout(p.id, "retry", !!p.broadcastTxHash)}
                      disabled={retryingId === p.id}
                      variant={p.broadcastTxHash ? "amber" : "green"}
                    >
                      {retryingId === p.id ? "Retrying…" : p.broadcastTxHash ? "⚠️ Confirm Retry" : "↻ Retry"}
                    </Btn>
                    <Btn onClick={() => resolveFailedPayout(p.id, "dismiss")} disabled={retryingId === p.id} variant="red">
                      Dismiss (no txn)
                    </Btn>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 2 }}>
                    <input
                      type="text"
                      placeholder="Verified tx hash from Basescan (optional)"
                      value={dismissDrafts[p.id] ?? ""}
                      onChange={(e) => setDismissDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))}
                      style={{
                        flex: 1, minWidth: 220, fontSize: 11, fontFamily: "monospace",
                        padding: "4px 8px", borderRadius: 6,
                        border: `1px solid ${T.border}`, background: T.surface, color: T.cream,
                      }}
                    />
                    <Btn
                      onClick={() => resolveFailedPayout(p.id, "dismiss", false, dismissDrafts[p.id]?.trim())}
                      disabled={retryingId === p.id || !dismissDrafts[p.id]?.trim()}
                      variant="amber"
                    >
                      Dismiss + Log Txn
                    </Btn>
                  </div>
                  {p.broadcastTxHash && (
                    <div style={{ fontSize: 11, color: C.amberGlow, paddingLeft: 2 }}>
                      ⚠️ Already broadcast — check{" "}
                      <a
                        href={`https://basescan.org/tx/${p.broadcastTxHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: C.amberGlow, textDecoration: "underline" }}
                      >
                        tx {p.broadcastTxHash.slice(0, 10)}…
                      </a>{" "}
                      on Basescan before retrying — if it landed, Dismiss instead.
                    </div>
                  )}
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

        {/* ── Player progress (full width) ── */}
        <div style={{ marginTop: "1rem" }}>
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "1.25rem" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
              <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: T.creamMute, margin: 0 }}>Player Progress</p>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <FilterToggle label="🔕" value={playerNotifFilter} onChange={setPlayerNotifFilter} dark={dark} />
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
            </div>
            {users.length === 0 ? (
              <p style={{ fontSize: 13, color: T.textMute }}>No players yet.</p>
            ) : (
              <>
                <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: C.green, margin: "0 0 8px" }}>
                  Real Players · {(playerSearchQuery || globalSearchQuery || playerNotifFilter !== "all") ? `${filteredRealUsers.length}/${realUsers.length}` : realUsers.length}
                </p>
                {filteredRealUsers.length === 0 ? (
                  <p style={{ fontSize: 12, color: T.textMute, margin: "0 0 14px" }}>{(playerSearchQuery || globalSearchQuery || playerNotifFilter !== "all") ? "No matches." : "None yet."}</p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 220, overflowY: "auto", paddingRight: 10, marginBottom: 28 }}>
                    {[...filteredRealUsers].sort((a, b) => (b.xp || 0) - (a.xp || 0)).map((u) => {
                      const profile = profiles[String(u.fid)];
                      const bothOff = !u.hasAddedApp && !u.hasNotifToken;
                      const isWallet = String(u.fid).startsWith("wallet:");
                      return (
                        <div key={u.fid} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <div style={{ width: isWallet ? "auto" : 110, flexShrink: isWallet ? 1 : 0, minWidth: 0 }}>
                            <button
                              onClick={() => { setLookupFid(u.fid); loadUserControl(u.fid); }}
                              style={{
                                fontSize: 13,
                                color: bothOff ? C.red : (dark ? C.amberGlow : "#7c3aed"),
                                fontWeight: bothOff ? 700 : 600,
                                background: "transparent", border: "none", cursor: "pointer", fontFamily: "monospace", textAlign: "left", padding: 0,
                                textShadow: bothOff ? "none" : (dark ? `0 0 8px ${C.amberGlow}66` : "none"),
                                display: "inline-flex", alignItems: "center", gap: 3,
                                whiteSpace: isWallet ? "normal" : "nowrap",
                                wordBreak: isWallet ? "break-all" : "normal",
                              }}
                              title="Open in user panel"
                            >
                              {bothOff && <span>🔕</span>}
                              {isWallet ? u.fid : `#${u.fid}`}
                            </button>
                          </div>
                          {!isWallet && (
                            profile?.username ? (
                              <a
                                href={`https://farcaster.xyz/${profile.username}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ fontSize: 12, color: dark ? "#f1f5f9" : T.textSub, textDecoration: "none" }}
                                title={profile.displayName ?? profile.username}
                              >
                                @{profile.username}
                              </a>
                            ) : profile === undefined ? (
                              <span style={{ fontSize: 12, color: T.textMute }}>…</span>
                            ) : (
                              <span style={{ fontSize: 12, color: dark ? "#f1f5f9" : T.textSub }}>—</span>
                            )
                          )}
                          {u.accessoriesUnlocked && u.accessoriesUnlocked.length > 0 && (
                            <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 4, minWidth: 0 }}>
                              {u.accessoriesUnlocked.map((id) => (
                                <span key={id} title={id} style={{
                                  fontSize: 10, padding: "2px 8px", borderRadius: 5,
                                  background: T.bg, border: `1px solid ${dark ? C.amberGlow : "#7c3aed"}55`,
                                  color: dark ? C.amberGlow : "#7c3aed", fontWeight: 500, whiteSpace: "nowrap",
                                }}>
                                  {id}
                                </span>
                              ))}
                            </span>
                          )}
                          <span style={{ fontSize: 12, color: dark ? "#f1f5f9" : T.textMute, marginLeft: "auto", flexShrink: 0 }}>{(u.xp || 0).toLocaleString()} xp · {u.totalCheckIns || 0} checkin</span>
                        </div>
                      );
                    })}
                  </div>
                )}

                <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: dark ? "#e2e8f0" : T.textMute, margin: "0 0 8px", paddingTop: 14, borderTop: `1px solid ${T.borderSub}` }}>
                  Unconverted Opens · {(playerSearchQuery || globalSearchQuery || playerNotifFilter !== "all") ? `${filteredGhostUsers.length}/${ghostUsers.length}` : ghostUsers.length}
                </p>
                {filteredGhostUsers.length === 0 ? (
                  <p style={{ fontSize: 12, color: T.textMute }}>{(playerSearchQuery || globalSearchQuery || playerNotifFilter !== "all") ? "No matches." : "None — every opener has progressed."}</p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 140, overflowY: "auto", paddingRight: 10 }}>
                    {filteredGhostUsers.map((u) => {
                      const profile = profiles[String(u.fid)];
                      const bothOff = !u.hasAddedApp && !u.hasNotifToken;
                      const isWallet = String(u.fid).startsWith("wallet:");
                      return (
                        <div key={u.fid} style={{ display: "flex", alignItems: "center", gap: 12, opacity: 0.85 }}>
                          <div style={{ width: isWallet ? "auto" : 110, flexShrink: isWallet ? 1 : 0, minWidth: 0 }}>
                            <button
                              onClick={() => { setLookupFid(u.fid); loadUserControl(u.fid); }}
                              style={{
                                fontSize: 13,
                                color: bothOff ? C.red : (dark ? C.amberGlow : "#7c3aed"),
                                fontWeight: bothOff ? 700 : 600,
                                background: "transparent", border: "none", cursor: "pointer", fontFamily: "monospace", textAlign: "left", padding: 0,
                                display: "inline-flex", alignItems: "center", gap: 3,
                                whiteSpace: isWallet ? "normal" : "nowrap",
                                wordBreak: isWallet ? "break-all" : "normal",
                              }}
                              title="Open in user panel"
                            >
                              {bothOff && <span>🔕</span>}
                              {isWallet ? u.fid : `#${u.fid}`}
                            </button>
                          </div>
                          {!isWallet && (
                            profile?.username ? (
                              <a
                                href={`https://farcaster.xyz/${profile.username}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ fontSize: 12, color: dark ? "#f1f5f9" : T.textSub, textDecoration: "none" }}
                                title={profile.displayName ?? profile.username}
                              >
                                @{profile.username}
                              </a>
                            ) : (
                              <span style={{ fontSize: 12, color: dark ? "#f1f5f9" : T.textSub }}>—</span>
                            )
                          )}
                          {u.accessoriesUnlocked && u.accessoriesUnlocked.length > 0 && (
                            <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 4, minWidth: 0 }}>
                              {u.accessoriesUnlocked.map((id) => (
                                <span key={id} title={id} style={{
                                  fontSize: 10, padding: "2px 8px", borderRadius: 5,
                                  background: T.bg, border: `1px solid ${dark ? C.amberGlow : "#7c3aed"}55`,
                                  color: dark ? C.amberGlow : "#7c3aed", fontWeight: 500, whiteSpace: "nowrap",
                                }}>
                                  {id}
                                </span>
                              ))}
                            </span>
                          )}
                          <span style={{ fontSize: 12, color: dark ? "#f1f5f9" : T.textMute, marginLeft: "auto", flexShrink: 0 }}>0 xp · 0 checkin</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* ── Transactions by type (full width, compact — mirrors the Spin Wheel Results card style below) ── */}
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "1.25rem", marginTop: "1rem" }}>
          <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: T.creamMute, margin: "0 0 14px" }}>Transactions by Type</p>
          {Object.keys(byType).length === 0 ? (
            <p style={{ fontSize: 13, color: T.textMute }}>No transactions yet.</p>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
              {Object.entries(byType).map(([type, count]) => {
                const meta = TYPE_META[type] ?? { color: T.textSub, bg: T.surfaceAlt, label: type };
                const pct = Math.round((count / txns.length) * 100);
                return (
                  <div key={type} style={{ background: T.surfaceAlt, border: `1px solid ${T.borderSub}`, borderRadius: 10, padding: "12px 14px" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                      <Badge color={meta.color} bg={meta.bg}>{meta.label}</Badge>
                      <span style={{ fontSize: 11, color: T.textMute }}>{pct}%</span>
                    </div>
                    <p style={{ fontSize: 22, fontWeight: 800, color: meta.color, margin: 0, fontVariantNumeric: "tabular-nums" }}>{count}</p>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Missing txn-log backfill ── */}
        {/* Reconstructs any txn-log entries missing due to the wallet-only
            (Base App) logging gap — see grub:used-tx:* records in KV.
            Two-step by design: Check shows what would be added (no writes),
            Confirm actually commits it. */}
        <SectionLabel dark={dark} accent={C.blue}>Missing Transactions</SectionLabel>
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "14px 16px", marginBottom: "1rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <p style={{ fontSize: 12, color: T.textSub, margin: 0, flex: 1, minWidth: 200 }}>
              {missingTxns === null
                ? "Scans on-chain payment records for purchases that never made it into the log above (e.g. wallet-only Base App users before the logging fix)."
                : missingTxns.length === 0
                ? "✓ Nothing missing — the txn log is fully up to date."
                : `Found ${missingTxns.length} transaction${missingTxns.length === 1 ? "" : "s"} missing from the log. Review below, then confirm to add ${missingTxns.length === 1 ? "it" : "them"}.`}
            </p>
            <Btn onClick={checkMissingTxns} disabled={missingTxnsLoading} variant="default">
              {missingTxnsLoading ? "Checking…" : missingTxns === null ? "Check for Missing Transactions" : "Re-check"}
            </Btn>
            {missingTxns !== null && missingTxns.length > 0 && (
              <Btn onClick={confirmBackfillTxns} disabled={backfillingTxns} variant="green">
                {backfillingTxns ? "Adding…" : `✓ Confirm & Add ${missingTxns.length}`}
              </Btn>
            )}
          </div>

          {missingTxns !== null && missingTxns.length > 0 && (
            <div style={{ marginTop: 12, overflowX: "auto", maxHeight: 200, overflowY: "auto", border: `1px solid ${T.borderSub}`, borderRadius: 8 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: T.surfaceAlt, position: "sticky", top: 0 }}>
                    {["Type", "FID", "Detail", "Amount", "Tx"].map((h, i) => (
                      <th key={h} style={{
                        textAlign: i >= 3 ? "right" : "left", padding: "8px 12px", color: T.creamMute,
                        fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", fontSize: 10,
                        borderBottom: `1px solid ${T.border}`, background: T.surfaceAlt,
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {missingTxns.map((t, i) => {
                    const meta = TYPE_META[t.type] ?? { color: T.textSub, bg: T.surfaceAlt, label: t.type };
                    const detail = t.type === "accessory_unlock" ? (t.accessoryName || t.accessoryId || "") : "—";
                    return (
                      <tr key={i} style={{ borderBottom: `1px solid ${T.borderSub}` }}>
                        <td style={{ padding: "8px 12px" }}><Badge color={meta.color} bg={meta.bg}>{meta.label}</Badge></td>
                        <td style={{ padding: "8px 12px", fontFamily: "monospace", color: dark ? C.amberGlow : "#7c3aed", fontSize: 11 }}>{t.fid}</td>
                        <td style={{ padding: "8px 12px", color: T.textSub }}>{detail}</td>
                        <td style={{ padding: "8px 12px", textAlign: "right", fontWeight: 600, color: C.green }}>${(t.amountUsd || 0).toFixed(2)}</td>
                        <td style={{ padding: "8px 12px", textAlign: "right" }}>
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
          )}
        </div>

        </div>
        {/* ── Games tab content: Spin Wheel Results, Raffle, Coin Toss ── */}
        <div style={{ display: mainTab === "games" ? "contents" : "none" }}>
        {/* ── Spin Wheel results ──────────────────────────────────────────
            Dedicated view of every wheel spin (fid -> what they won), since
            these can get diluted in the general Transaction Log once volume
            picks up. Pulled from the FULL txn list, not the 500-row cap
            below, so nothing here ever silently drops off. */}
        <SectionLabel dark={dark} accent="#e879f9">Spin Wheel Results</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: "1rem" }}>
          {[
            { key: "total", label: "Total Spins", count: wheelSpinTxns.length, color: "#e879f9" },
            { key: "rare", label: "🌟 Rare Accessory", count: wheelBreakdown.rare, color: "#FF3CAC" },
            { key: "freecheckin", label: "🎟️ Free Check-in", count: wheelBreakdown.freecheckin, color: C.blue },
            { key: "streaksave", label: "🛡️ Streak Save", count: wheelBreakdown.streaksave, color: C.green },
            { key: "xp", label: "✨ XP", count: wheelBreakdown.xp, color: C.amberGlow },
          ].map((card) => (
            <div key={card.key} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "12px 14px" }}>
              <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: T.creamMute, margin: "0 0 6px" }}>{card.label}</p>
              <p style={{ fontSize: 22, fontWeight: 800, color: card.color, margin: 0, fontVariantNumeric: "tabular-nums" }}>{card.count}</p>
            </div>
          ))}
        </div>
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden", marginBottom: "1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: `1px solid ${T.borderSub}` }}>
            <span style={{ fontSize: 12, color: T.textMute }}>
              {globalSearchQuery
                ? `Showing ${filteredWheelSpinTxns.length} matching "${globalSearchQuery}" (of ${wheelSpinTxns.length} total spins)`
                : `${wheelSpinTxns.length} total spin${wheelSpinTxns.length === 1 ? "" : "s"}`}
            </span>
          </div>
          <div style={{ overflowX: "auto", maxHeight: 280, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: T.surfaceAlt, position: "sticky", top: 0 }}>
                  {["FID", "Result", "Paid", "When", "Tx"].map((h, i) => (
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
                {filteredWheelSpinTxns.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ padding: "24px 14px", textAlign: "center", color: T.textMute }}>{globalSearchQuery ? "No matching spins." : "No spins logged yet."}</td>
                  </tr>
                ) : filteredWheelSpinTxns.map((t, i) => {
                  const bucket = classifyWheelReward(t.wheelReward ?? "");
                  const resultColor = bucket === "rare" ? "#FF3CAC" : bucket === "freecheckin" ? C.blue : bucket === "streaksave" ? C.green : C.amberGlow;
                  return (
                    <tr
                      key={i}
                      style={{
                        borderBottom: `1px solid ${T.borderSub}`,
                        background: i % 2 === 0 ? "transparent" : T.surfaceAlt + "55",
                      }}
                    >
                      <td style={{ padding: "9px 14px", fontFamily: "monospace", color: dark ? C.amberGlow : "#7c3aed", fontSize: 11 }}>{t.fid}</td>
                      <td style={{ padding: "9px 14px", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: resultColor, fontWeight: 600 }} title={t.wheelReward}>
                        {t.wheelReward || "—"}
                      </td>
                      <td style={{ padding: "9px 14px", textAlign: "right", fontWeight: 600, color: C.green }}>${(t.amountUsd || 0).toFixed(2)}</td>
                      <td style={{ padding: "9px 14px", textAlign: "right", color: T.textMute, whiteSpace: "nowrap" }}>{timeAgo(t.ts)}</td>
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

        {/* ── Raffle ── */}
        <SectionLabel dark={dark} accent="#fbbf24">🎟️ Raffle</SectionLabel>
        {raffleAdminError && (
          <div style={{ background: C.redDim, border: `1px solid ${C.red}`, borderRadius: 10, padding: "10px 14px", marginBottom: "1rem", color: C.red, fontSize: 12 }}>
            {raffleAdminError}
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: "1rem" }}>
          {[
            { key: "open", label: "Open Round", value: raffleAdmin?.open?.id ?? "—", color: "#fbbf24" },
            { key: "tickets", label: "Tickets Sold (open)", value: raffleAdmin?.open?.ticketCount ?? 0, color: C.green },
            { key: "entrants", label: "Entrants (open)", value: raffleAdmin?.open?.entrants?.length ?? 0, color: C.blue },
            { key: "awaiting", label: "Awaiting Reveal", value: raffleAdmin?.awaitingReveal?.id ?? "none", color: C.purple },
          ].map((card) => (
            <div key={card.key} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "12px 14px" }}>
              <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: T.creamMute, margin: "0 0 6px" }}>{card.label}</p>
              <p style={{ fontSize: 18, fontWeight: 800, color: card.color, margin: 0, fontVariantNumeric: "tabular-nums" }}>{String(card.value)}</p>
            </div>
          ))}
        </div>

        {raffleAdmin?.open && (
          <div style={{
            display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
            background: T.surface, border: `1px solid ${raffleAdmin.open.prizeKind ? T.border : C.red}`, borderRadius: 12,
            padding: "10px 14px", marginBottom: "1rem",
          }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: T.creamMute }}>
              Prize for round {raffleAdmin.open.id}:
            </span>
            <select
              value={raffleAdmin.open.prizeKind ?? ""}
              onChange={(e) => e.target.value && setRafflePrizeKind(raffleAdmin.open.id, e.target.value)}
              disabled={raffleActionLoading === `prizekind_${raffleAdmin.open.id}`}
              style={{
                background: T.surfaceAlt, color: T.cream, border: `1px solid ${T.border}`, borderRadius: 6,
                padding: "5px 8px", fontSize: 12, fontWeight: 600,
              }}
            >
              <option value="" disabled>— Pending, select one —</option>
              {(raffleAdmin.prizeKinds ?? []).map((k: any) => (
                <option key={k.id} value={k.id}>{k.label}</option>
              ))}
            </select>
            {!raffleAdmin.open.prizeKind && (
              <span style={{ fontSize: 11, color: C.red }}>
                Pending — if not set before lock, system will auto-pick one at random.
              </span>
            )}
            {raffleAdmin.open.prizeKind && raffleAdmin.open.projectedPrize && (
              <span style={{ fontSize: 11, color: T.textMute }}>
                Projected: <b style={{ color: C.amberGlow }}>{raffleAdmin.open.projectedPrize.value} {raffleAdmin.open.projectedPrize.label}</b> at current {raffleAdmin.open.ticketCount ?? 0} ticket(s) — updates live as tickets sell, final at lock
              </span>
            )}
            {raffleAdmin.open.prizeKind === "accessory" && (
              <span style={{ fontSize: 11, color: T.textMute }}>Accessory — you'll pick the specific item after reveal, no ticket-based amount.</span>
            )}
          </div>
        )}

        <div style={{ display: "flex", gap: 10, marginBottom: "1rem", flexWrap: "wrap" }}>
          <button
            onClick={forceDrawRaffle}
            disabled={raffleActionLoading === "force_draw"}
            style={{
              background: "#fbbf24", color: "#1a1305", border: "none", borderRadius: 8,
              padding: "8px 14px", fontSize: 12, fontWeight: 700, cursor: raffleActionLoading ? "wait" : "pointer",
            }}
          >
            {raffleActionLoading === "force_draw" ? "Drawing…" : "⚡ Force Draw Now"}
          </button>
          {raffleAdmin?.awaitingReveal && (
            <button
              onClick={forceRevealOnly}
              disabled={raffleActionLoading === "force_reveal_only"}
              style={{
                background: C.purple, color: "#fff", border: "none", borderRadius: 8,
                padding: "8px 14px", fontSize: 12, fontWeight: 700, cursor: raffleActionLoading ? "wait" : "pointer",
              }}
            >
              {raffleActionLoading === "force_reveal_only" ? "Revealing…" : "🔮 Force Reveal Only"}
            </button>
          )}
          {raffleAdmin?.open && (
            <button
              onClick={() => voidRaffleRound(raffleAdmin.open.id)}
              disabled={raffleActionLoading === `void_${raffleAdmin.open.id}`}
              style={{
                background: "transparent", color: C.red, border: `1px solid ${C.red}`, borderRadius: 8,
                padding: "8px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer",
              }}
            >
              {raffleActionLoading === `void_${raffleAdmin.open.id}` ? "Voiding…" : `Void Open Round (${raffleAdmin.open.id})`}
            </button>
          )}
          {raffleAdmin?.awaitingReveal && (
            <button
              onClick={() => voidRaffleRound(raffleAdmin.awaitingReveal.id)}
              disabled={raffleActionLoading === `void_${raffleAdmin.awaitingReveal.id}`}
              style={{
                background: "transparent", color: C.red, border: `1px solid ${C.red}`, borderRadius: 8,
                padding: "8px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer",
              }}
            >
              {raffleActionLoading === `void_${raffleAdmin.awaitingReveal.id}` ? "Voiding…" : `Void Awaiting-Reveal (${raffleAdmin.awaitingReveal.id})`}
            </button>
          )}
          <button
            onClick={loadRaffleAdmin}
            disabled={raffleAdminLoading}
            style={{
              background: "transparent", color: T.creamMute, border: `1px solid ${T.border}`, borderRadius: 8,
              padding: "8px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer",
            }}
          >
            {raffleAdminLoading ? "Loading…" : "↻ Refresh"}
          </button>
        </div>

        {/* Entrants — open round */}
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden", marginBottom: "1rem" }}>
          <div style={{ padding: "12px 16px", borderBottom: `1px solid ${T.borderSub}` }}>
            <span style={{ fontSize: 12, color: T.textMute }}>
              Entrants — open round {raffleAdmin?.open?.id ?? ""} {raffleAdmin?.open?.locksAt ? `· locks in ${timeUntil(raffleAdmin.open.locksAt)}` : ""}
            </span>
          </div>
          <div style={{ overflowX: "auto", maxHeight: 240, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: T.surfaceAlt, position: "sticky", top: 0 }}>
                  {["Identity", "Tickets"].map((h, i) => (
                    <th key={h} style={{
                      textAlign: i >= 1 ? "right" : "left", padding: "9px 14px", color: T.creamMute, fontWeight: 700,
                      letterSpacing: "0.06em", textTransform: "uppercase", fontSize: 10,
                      borderBottom: `1px solid ${T.border}`, background: T.surfaceAlt,
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {!raffleAdmin?.open?.entrants?.length ? (
                  <tr><td colSpan={2} style={{ padding: "24px 14px", textAlign: "center", color: T.textMute }}>No entrants yet this round.</td></tr>
                ) : raffleAdmin.open.entrants.map((e: any, i: number) => (
                  <tr key={e.identityKey} style={{ borderBottom: `1px solid ${T.borderSub}`, background: i % 2 === 0 ? "transparent" : T.surfaceAlt + "55" }}>
                    <td style={{ padding: "9px 14px", fontFamily: "monospace", color: dark ? C.amberGlow : "#7c3aed", fontSize: 11 }}>{e.identityKey}</td>
                    <td style={{ padding: "9px 14px", textAlign: "right", fontWeight: 700, color: C.green }}>{e.tickets}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Awaiting-reveal round detail, only shown when one exists */}
        {raffleAdmin?.awaitingReveal && (
          <div style={{ background: T.surface, border: `1px solid ${C.purple}`, borderRadius: 12, padding: "12px 16px", marginBottom: "1rem", fontSize: 12, color: T.textMute }}>
            Round {raffleAdmin.awaitingReveal.id} locked with {raffleAdmin.awaitingReveal.ticketCountAtLock ?? 0} ticket(s).
            {" "}Prize: <b>{raffleAdmin.awaitingReveal.prizeKind ? (raffleAdmin.prizeKinds ?? []).find((k: any) => k.id === raffleAdmin.awaitingReveal.prizeKind)?.label ?? raffleAdmin.awaitingReveal.prizeKind : "—"}</b>
            {raffleAdmin.awaitingReveal.projectedPrize && (
              <> — <b style={{ color: C.amberGlow }}>{raffleAdmin.awaitingReveal.projectedPrize.value} {raffleAdmin.awaitingReveal.projectedPrize.label}</b> (final, locked in)</>
            )}
            {raffleAdmin.awaitingReveal.prizeKindAutoSelected && <span style={{ color: C.red }}> (auto-selected — none was set before lock)</span>}
            .
            {" "}Target block {raffleAdmin.awaitingReveal.targetBlock ?? "—"}
            {raffleAdmin.awaitingReveal.currentBlock != null && raffleAdmin.awaitingReveal.targetBlock != null && (
              <>
                {" "}· currently at <b style={{ color: raffleAdmin.awaitingReveal.currentBlock >= raffleAdmin.awaitingReveal.targetBlock ? C.green : T.textMute }}>
                  {raffleAdmin.awaitingReveal.currentBlock}/{raffleAdmin.awaitingReveal.targetBlock}
                </b>
                {raffleAdmin.awaitingReveal.currentBlock >= raffleAdmin.awaitingReveal.targetBlock
                  ? " (past target — safe to Force Reveal Only)"
                  : ` (${raffleAdmin.awaitingReveal.targetBlock - raffleAdmin.awaitingReveal.currentBlock} blocks left)`}
              </>
            )}
            {" "}— will reveal automatically once that block is mined, or click Force Reveal Only above (updates on manual Refresh, not automatically).
          </div>
        )}

        {/* History */}
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden" }}>
          <div style={{ padding: "12px 16px", borderBottom: `1px solid ${T.borderSub}` }}>
            <span style={{ fontSize: 12, color: T.textMute }}>Round History</span>
          </div>
          <div style={{ overflowX: "auto", maxHeight: 280, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: T.surfaceAlt, position: "sticky", top: 0 }}>
                  {["Round", "Status", "Tickets", "Winner", "Prize", "Resolved", "Refunds"].map((h, i) => (
                    <th key={h} style={{
                      textAlign: i >= 2 ? "right" : "left", padding: "9px 14px", color: T.creamMute, fontWeight: 700,
                      letterSpacing: "0.06em", textTransform: "uppercase", fontSize: 10,
                      borderBottom: `1px solid ${T.border}`, background: T.surfaceAlt,
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {!raffleAdmin?.history?.length ? (
                  <tr><td colSpan={7} style={{ padding: "24px 14px", textAlign: "center", color: T.textMute }}>No rounds resolved yet.</td></tr>
                ) : raffleAdmin.history.map((r: any, i: number) => {
                  const statusColor = r.status === "resolved" ? C.green : r.status === "void" ? C.red : r.status === "no_entrants" ? T.creamMute : C.blue;
                  const ticketPrice = r.ticketPriceMicroUsdc ?? 100_000;
                  const entrants = r.entrants ?? []; // only populated by the API for void rounds
                  const refundedCount = entrants.filter((e: any) => r.refunds?.[e.identityKey]).length;
                  const isExpanded = expandedVoidRoundId === r.id;
                  return (
                    <Fragment key={r.id}>
                      <tr style={{ borderBottom: `1px solid ${T.borderSub}`, background: i % 2 === 0 ? "transparent" : T.surfaceAlt + "55" }}>
                        <td style={{ padding: "9px 14px", fontWeight: 600 }}>{r.id}</td>
                        <td style={{ padding: "9px 14px", color: statusColor, fontWeight: 700, textTransform: "capitalize" }}>{r.status.replace("_", " ")}</td>
                        <td style={{ padding: "9px 14px", textAlign: "right" }}>{r.ticketCountAtLock ?? 0}</td>
                        <td style={{ padding: "9px 14px", textAlign: "right", fontFamily: "monospace", fontSize: 11, color: dark ? C.amberGlow : "#7c3aed" }}>{r.winnerKey ?? "—"}</td>
                        <td style={{ padding: "9px 14px", textAlign: "right", color: C.amberGlow }}>
                          {r.pendingPrize ? (
                            r.pendingPrize.kind === "degen" ? (
                              r.pendingPrize.status === "fulfilled" ? (
                                <span style={{ color: C.green, fontSize: 11 }} title={r.pendingPrize.txHash}>
                                  ✓ {r.pendingPrize.amountDegen} DEGEN sent
                                </span>
                              ) : (
                                <button
                                  onClick={() => sendDegenPrize(r.id, r.pendingPrize.amountDegen, r.pendingPrize.winnerKey)}
                                  disabled={raffleActionLoading === `degenprize_${r.id}`}
                                  style={{
                                    background: C.amberGlow, color: "#1a1305", border: "none", borderRadius: 6,
                                    padding: "4px 8px", fontSize: 10, fontWeight: 700, cursor: raffleActionLoading ? "wait" : "pointer",
                                  }}
                                >
                                  {raffleActionLoading === `degenprize_${r.id}` ? "Sending…" : `Send ${r.pendingPrize.amountDegen} DEGEN`}
                                </button>
                              )
                            ) : r.pendingPrize.status === "fulfilled" ? (
                              <span style={{ color: C.green, fontSize: 11 }}>✓ granted "{r.pendingPrize.accessoryId}"</span>
                            ) : (
                              <div style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                                <input
                                  value={raffleAccessoryInputs[r.id] ?? ""}
                                  onChange={(e) => setRaffleAccessoryInputs((prev) => ({ ...prev, [r.id]: e.target.value }))}
                                  placeholder="accessory id"
                                  style={{
                                    width: 90, background: T.surfaceAlt, color: T.cream, border: `1px solid ${T.border}`,
                                    borderRadius: 6, padding: "3px 6px", fontSize: 10,
                                  }}
                                />
                                <button
                                  onClick={() => grantRaffleAccessory(r.id, raffleAccessoryInputs[r.id] ?? "")}
                                  disabled={raffleActionLoading === `accessoryprize_${r.id}`}
                                  style={{
                                    background: C.amberGlow, color: "#1a1305", border: "none", borderRadius: 6,
                                    padding: "4px 8px", fontSize: 10, fontWeight: 700, cursor: raffleActionLoading ? "wait" : "pointer",
                                  }}
                                >
                                  {raffleActionLoading === `accessoryprize_${r.id}` ? "Granting…" : "Grant"}
                                </button>
                              </div>
                            )
                          ) : r.prizeTier ? (
                            `+${r.prizeTier.value} ${(raffleAdmin.prizeKinds ?? []).find((k: any) => k.id === r.prizeKind)?.label ?? r.prizeKind ?? "XP"}`
                          ) : (
                            "—"
                          )}
                        </td>
                        <td style={{ padding: "9px 14px", textAlign: "right", color: T.textMute, whiteSpace: "nowrap" }}>{r.resolvedAt ? timeAgo(r.resolvedAt) : r.voidedAt ? timeAgo(r.voidedAt) : "—"}</td>
                        <td style={{ padding: "9px 14px", textAlign: "right", whiteSpace: "nowrap" }}>
                          {r.status !== "void" ? (
                            <span style={{ color: T.textMute }}>—</span>
                          ) : entrants.length === 0 ? (
                            <span style={{ color: T.textMute }}>no entrants</span>
                          ) : (
                            <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                              <span style={{ color: refundedCount === entrants.length ? C.green : T.textMute, fontSize: 11 }}>
                                {refundedCount}/{entrants.length} refunded
                              </span>
                              <button
                                onClick={() => setExpandedVoidRoundId(isExpanded ? null : r.id)}
                                style={{
                                  background: "transparent", color: dark ? C.amberGlow : "#7c3aed", border: `1px solid ${T.border}`, borderRadius: 6,
                                  padding: "4px 8px", fontSize: 11, fontWeight: 700, cursor: "pointer",
                                }}
                              >
                                {isExpanded ? "Hide" : "View"}
                              </button>
                              {refundedCount < entrants.length && (
                                <button
                                  onClick={() => refundRaffleAll(r.id, entrants.length)}
                                  disabled={raffleActionLoading === `refundall_${r.id}`}
                                  style={{
                                    background: C.red, color: "#fff", border: "none", borderRadius: 6,
                                    padding: "4px 8px", fontSize: 11, fontWeight: 700, cursor: raffleActionLoading ? "wait" : "pointer",
                                  }}
                                >
                                  {raffleActionLoading === `refundall_${r.id}` ? "Refunding…" : "Refund All"}
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                      {isExpanded && r.status === "void" && (
                        <tr>
                          <td colSpan={7} style={{ padding: 0, background: dark ? "#0a0a0f" : "#faf7f2" }}>
                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                              <thead>
                                <tr>
                                  {["Identity", "Tickets", "Amount", "Status", ""].map((h, hi) => (
                                    <th key={h} style={{
                                      textAlign: hi >= 1 && hi <= 2 ? "right" : "left", padding: "7px 14px 7px 28px",
                                      color: T.creamMute, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", fontSize: 9,
                                      borderBottom: `1px solid ${T.borderSub}`,
                                    }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {entrants.map((e: any) => {
                                  const amountMicroUsdc = e.tickets * ticketPrice;
                                  const refund = r.refunds?.[e.identityKey];
                                  const loadingKey = `refund_${r.id}_${e.identityKey}`;
                                  return (
                                    <tr key={e.identityKey} style={{ borderBottom: `1px solid ${T.borderSub}` }}>
                                      <td style={{ padding: "7px 14px 7px 28px", fontFamily: "monospace", fontSize: 11, color: dark ? C.amberGlow : "#7c3aed" }}>{e.identityKey}</td>
                                      <td style={{ padding: "7px 14px", textAlign: "right" }}>{e.tickets}</td>
                                      <td style={{ padding: "7px 14px", textAlign: "right", color: C.green }}>${(amountMicroUsdc / 1_000_000).toFixed(2)}</td>
                                      <td style={{ padding: "7px 14px", textAlign: "right" }}>
                                        {refund ? (
                                          <span style={{ color: C.green, fontSize: 10 }} title={refund.txHash}>
                                            ✓ refunded ({refund.txHash?.slice(0, 8)}…)
                                          </span>
                                        ) : (
                                          <span style={{ color: T.textMute, fontSize: 10 }}>not refunded</span>
                                        )}
                                      </td>
                                      <td style={{ padding: "7px 14px", textAlign: "right" }}>
                                        {!refund && (
                                          <button
                                            onClick={() => refundRaffleEntrant(r.id, e.identityKey, amountMicroUsdc)}
                                            disabled={raffleActionLoading === loadingKey}
                                            style={{
                                              background: "transparent", color: C.red, border: `1px solid ${C.red}`, borderRadius: 6,
                                              padding: "3px 8px", fontSize: 10, fontWeight: 700, cursor: raffleActionLoading ? "wait" : "pointer",
                                            }}
                                          >
                                            {raffleActionLoading === loadingKey ? "Sending…" : "Refund"}
                                          </button>
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Mini Games: Coin Toss ── */}
        <SectionLabel dark={dark} accent="#dc2626">🪙 Mini Games — Coin Toss</SectionLabel>
        {minigamesAdminError && (
          <div style={{ background: C.redDim, border: `1px solid ${C.red}`, borderRadius: 10, padding: "10px 14px", marginBottom: "1rem", color: C.red, fontSize: 12 }}>
            {minigamesAdminError}
          </div>
        )}
        {minigamesAdminLoading && !minigamesAdmin ? (
          <div style={{ color: T.textMute, fontSize: 13, marginBottom: "1rem" }}>Loading…</div>
        ) : (
          <>
            {(minigamesAdmin?.alerts ?? []).length > 0 && (
              <div style={{ background: C.redDim, border: `1px solid ${C.red}`, borderRadius: 10, padding: "10px 14px", marginBottom: "1rem" }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: C.red, marginBottom: 4 }}>⚠ Circuit-breaker alerts</div>
                {minigamesAdmin.alerts.slice(0, 5).map((a: any) => (
                  <div key={a.id} style={{ fontSize: 11, color: T.textMute }}>{timeAgo(a.ts)} — {a.message}</div>
                ))}
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: "1rem" }}>
              {[
                { key: "status", label: "Status", value: minigamesAdmin?.config?.enabled ? "Live" : "Paused", color: minigamesAdmin?.config?.enabled ? C.green : C.red },
                { key: "treasury", label: "Treasury DEGEN", value: (minigamesAdmin?.stats?.treasuryDegenBalance ?? 0).toFixed(0), color: "#dc2626" },
                { key: "netAllTime", label: "House Net (all-time)", value: (minigamesAdmin?.stats?.allTime?.houseNet ?? 0).toFixed(1), color: (minigamesAdmin?.stats?.allTime?.houseNet ?? 0) >= 0 ? C.green : C.red },
                { key: "net24h", label: "House Net (24h)", value: (minigamesAdmin?.stats?.last24h?.houseNet ?? 0).toFixed(1), color: (minigamesAdmin?.stats?.last24h?.houseNet ?? 0) >= 0 ? C.green : C.red },
                { key: "winRate", label: "Win Rate", value: `${(minigamesAdmin?.stats?.allTime?.winRatePercent ?? 0).toFixed(1)}%`, color: C.blue },
                { key: "flips", label: "Total Flips", value: minigamesAdmin?.stats?.allTime?.flips ?? 0, color: T.cream },
              ].map((s) => (
                <div key={s.key} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "12px 14px" }}>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: T.creamMute }}>{s.label}</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: s.color, marginTop: 4 }}>{s.value}</div>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", gap: 10, marginBottom: "1rem" }}>
              <button
                onClick={toggleMinigamesEnabled}
                disabled={raffleActionLoading === "minigames_toggle"}
                style={{
                  background: minigamesAdmin?.config?.enabled ? C.red : C.green, color: "#fff", border: "none", borderRadius: 8,
                  padding: "8px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer",
                }}
              >
                {minigamesAdmin?.config?.enabled ? "⏸ Pause Coin Toss" : "▶ Resume Coin Toss"}
              </button>
              <button onClick={loadMinigamesAdmin} style={{ background: "transparent", color: T.creamMute, border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                ↺ Refresh
              </button>
            </div>

            <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "14px 16px", marginBottom: "1rem" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: T.creamMute, marginBottom: 10 }}>Config</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
                {[
                  { key: "minBetDegen", label: "Min bet (DEGEN)", hint: "Smallest bet a player can place per flip." },
                  { key: "maxBetDegen", label: "Max bet (DEGEN)", hint: "Largest bet a player can place per flip." },
                  { key: "feePercentOnWin", label: "Fee % on wins", hint: "Cut taken from the profit portion of a win only — e.g. 10 means winner keeps 90% of their profit. Losses are untouched." },
                  { key: "maxBetPercentOfTreasury", label: "Max bet % of treasury", hint: "Bet is also capped at this % of the live treasury, whichever is lower than Max bet." },
                  { key: "lossCircuitBreakerDegen", label: "24h loss circuit-breaker (DEGEN)", hint: "Coin Toss auto-pauses if rolling 24h house losses hit this — own bucket, separate from Dice's breaker." },
                  { key: "maxFlipsPerMinutePerUser", label: "Max flips/min/user", hint: "Rate limit — flips a single player can place per minute." },
                  { key: "autoCashoutMaxDegen", label: "Auto cash-out max (DEGEN)", hint: "Cash-out requests at or under this amount send immediately. Above it, they queue for manual admin approval." },
                  { key: "seedRotateAfterFlips", label: "Auto-rotate seed after N flips", hint: "Provably-fair seed auto-rotates (and reveals) once it's backed this many flips." },
                ].map((f) => {
                  const hintKey = `cointoss:${f.key}`;
                  const isOpen = openConfigHint === hintKey;
                  return (
                  <label key={f.key} data-config-hint style={{ fontSize: 11, color: T.creamMute, position: "relative", display: "block" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                      {f.label}
                      <button
                        type="button"
                        onClick={(e) => { e.preventDefault(); setOpenConfigHint(isOpen ? null : hintKey); }}
                        style={{
                          width: 14, height: 14, borderRadius: "50%", border: `1px solid ${T.border}`, background: "transparent",
                          color: T.textMute, fontSize: 9, fontWeight: 700, lineHeight: "12px", cursor: "pointer", padding: 0,
                          display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                        }}
                      >
                        ?
                      </button>
                    </span>
                    {isOpen && (
                      <div style={{
                        position: "absolute", top: "100%", left: 0, marginTop: 4, zIndex: 20, width: 220,
                        background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 10px",
                        fontSize: 10, fontWeight: 400, color: T.textSub, lineHeight: 1.4, boxShadow: "0 4px 14px rgba(0,0,0,0.35)",
                      }}>
                        {f.hint}
                      </div>
                    )}
                    <input
                      type="number"
                      value={minigamesConfigDraft[f.key] ?? ""}
                      onChange={(e) => setMinigamesConfigDraft((prev) => ({ ...prev, [f.key]: e.target.value }))}
                      style={{
                        display: "block", width: "100%", marginTop: 4, background: T.surfaceAlt, color: T.cream,
                        border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 8px", fontSize: 13,
                      }}
                    />
                  </label>
                  );
                })}
              </div>
              <button
                onClick={saveMinigamesConfig}
                disabled={raffleActionLoading === "minigames_config"}
                style={{ marginTop: 12, background: "#dc2626", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
              >
                {raffleActionLoading === "minigames_config" ? "Saving…" : "Save Config"}
              </button>
            </div>

            <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden", marginTop: "1rem", marginBottom: "1.5rem" }}>
              <div style={{ padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, borderBottom: `1px solid ${T.border}` }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: T.creamMute }}>
                  Cash-outs
                  {(() => {
                    const pendingCount = (minigamesAdmin?.recentCashouts ?? []).filter((c: any) => c.status === "pending").length;
                    return pendingCount > 0 ? ` (${pendingCount} pending)` : "";
                  })()}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <input
                    placeholder="Search FID or wallet…"
                    value={cashoutSearch}
                    onChange={(e) => setCashoutSearch(e.target.value)}
                    style={{ background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 9px", fontSize: 11, color: T.cream, minWidth: 180 }}
                  />
                  <span style={{ fontSize: 11, color: T.textMute, whiteSpace: "nowrap" }}>
                    {(() => {
                      const q = cashoutSearch.trim().toLowerCase();
                      const all = minigamesAdmin?.recentCashouts ?? [];
                      const filteredCount = all.filter((c: any) =>
                        !q || c.identityKey?.toLowerCase().includes(q) || c.wallet?.toLowerCase().includes(q)
                      ).length;
                      return `${filteredCount} of ${all.length} rows`;
                    })()}
                  </span>
                </div>
              </div>
              <div style={{ maxHeight: 320, overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr>
                      {["Identity", "Wallet", "Game", "Amount", "Requested", "Status"].map((h, i) => (
                        <th key={h} style={{ textAlign: i >= 3 ? "right" : "left", padding: "9px 14px", color: T.creamMute, fontWeight: 700, fontSize: 10, textTransform: "uppercase", borderBottom: `1px solid ${T.border}`, background: T.surfaceAlt, position: "sticky", top: 0 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const q = cashoutSearch.trim().toLowerCase();
                      const rows = (minigamesAdmin?.recentCashouts ?? []).filter((c: any) =>
                        !q || c.identityKey?.toLowerCase().includes(q) || c.wallet?.toLowerCase().includes(q)
                      );
                      if (rows.length === 0) {
                        return <tr><td colSpan={6} style={{ padding: "20px 14px", textAlign: "center", color: T.textMute }}>{q ? "No matching cash-outs." : "No cash-outs yet."}</td></tr>;
                      }
                      return rows.map((c: any) => (
                      <tr key={c.id} style={{ borderBottom: `1px solid ${T.borderSub}`, opacity: c.status === "cancelled" ? 0.5 : 1 }}>
                        <td style={{ padding: "9px 14px", fontFamily: "monospace" }}>{c.identityKey}</td>
                        <td style={{ padding: "9px 14px", fontFamily: "monospace", fontSize: 11 }}>{c.wallet}</td>
                        <td style={{ padding: "9px 14px" }}>
                          {/* sourceGame is a UI breadcrumb — which panel the
                              player clicked "Cash Out" from, not a real
                              ledger split (balance is fully shared). Blank
                              for cash-outs requested before this field
                              existed. */}
                          {c.sourceGame ? (
                            <span style={{
                              fontSize: 10, fontWeight: 700, borderRadius: 5, padding: "2px 7px",
                              background: c.sourceGame === "dice" ? "#3730a3" : "#78350f",
                              color: c.sourceGame === "dice" ? "#c7d2fe" : "#fed7aa",
                            }}>
                              {c.sourceGame === "dice" ? "🎲 Dice" : "🪙 Coin Toss"}
                            </span>
                          ) : (
                            <span style={{ fontSize: 10, color: T.textMute }}>—</span>
                          )}
                        </td>
                        <td style={{
                          padding: "9px 14px", textAlign: "right", fontWeight: 700,
                          color: c.status === "cancelled" ? T.textMute : "#dc2626",
                          textDecoration: c.status === "cancelled" ? "line-through" : "none",
                        }}>{c.amountDegen} DEGEN</td>
                        <td style={{ padding: "9px 14px", textAlign: "right", color: T.textMute }}>{timeAgo(c.requestedAt)}</td>
                        <td style={{ padding: "9px 14px" }}>
                          {c.status === "pending" ? (
                            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                              <button
                                onClick={() => cancelMinigamesCashout(c.id)}
                                disabled={raffleActionLoading === `cashout_${c.id}` || raffleActionLoading === `cashout_cancel_${c.id}`}
                                style={{ background: "transparent", color: "#dc2626", border: "1px solid #dc2626", borderRadius: 6, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                              >
                                {raffleActionLoading === `cashout_cancel_${c.id}` ? "…" : "Cancel"}
                              </button>
                              <button
                                onClick={() => fulfillMinigamesCashout(c.id)}
                                disabled={raffleActionLoading === `cashout_${c.id}` || raffleActionLoading === `cashout_cancel_${c.id}`}
                                style={{ background: "#dc2626", color: "#fff", border: "none", borderRadius: 6, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                              >
                                {raffleActionLoading === `cashout_${c.id}` ? "Sending…" : "Send"}
                              </button>
                            </div>
                          ) : c.status === "fulfilled" ? (
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
                              <span style={{ fontSize: 10, fontWeight: 700, color: C.green }}>✓ Sent</span>
                              {c.txHash && (
                                <a href={`https://basescan.org/tx/${c.txHash}`} target="_blank" rel="noopener noreferrer"
                                  style={{ color: dark ? C.blue : "#1d4ed8", fontSize: 11, fontWeight: 600, textDecoration: "none" }}>
                                  ↗ view
                                </a>
                              )}
                            </div>
                          ) : (
                            <div style={{ textAlign: "right" }}>
                              <span style={{ fontSize: 10, fontWeight: 700, color: T.textMute }}>Cancelled</span>
                            </div>
                          )}
                        </td>
                      </tr>
                      ));
                    })()}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ── Player Stats — only identities that have actually flipped;
                a manual credit alone or a plain balance with zero plays
                doesn't earn a row here ── */}
            <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden", marginBottom: "1rem" }}>
              <div style={{ padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, borderBottom: `1px solid ${T.border}` }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: T.creamMute }}>
                  Player Stats — {(minigamesAdmin?.playerStats ?? []).length} players
                </div>
                <button
                  onClick={backfillMinigamesTotals}
                  disabled={raffleActionLoading === "minigames_backfill_totals"}
                  title="One-time: seeds permanent per-player totals from the current flip log. Only needed once, right after this update ships."
                  style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.creamMute, borderRadius: 6, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                >
                  {raffleActionLoading === "minigames_backfill_totals" ? "Seeding…" : "⚙ Backfill Totals (one-time)"}
                </button>
              </div>
              <div style={{ maxHeight: 360, overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr>
                      {["Identity", "Balance", "Deposited", "Total Wagered", "Bet on Wins", "Won", "Lost", "Net P/L", "Flips", "Last Played", "Actions"].map((h, i) => (
                        <th key={h} style={{ textAlign: i === 0 ? "left" : "right", padding: "9px 14px", color: T.creamMute, fontWeight: 700, fontSize: 10, textTransform: "uppercase", borderBottom: `1px solid ${T.border}`, background: T.surfaceAlt, position: "sticky", top: 0 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(minigamesAdmin?.playerStats ?? []).length === 0 ? (
                      <tr><td colSpan={11} style={{ padding: "20px 14px", textAlign: "center", color: T.textMute }}>No one has played Coin Toss yet.</td></tr>
                    ) : (minigamesAdmin.playerStats as CoinTossPlayerStats[]).map((p) => (
                      <tr key={p.identityKey} style={{ borderBottom: `1px solid ${T.borderSub}` }}>
                        <td style={{ padding: "9px 14px", fontFamily: "monospace" }}>{p.identityKey}</td>
                        <td style={{ padding: "9px 14px", textAlign: "right", fontWeight: 700, color: T.cream }}>{p.balance.toFixed(1)}</td>
                        <td style={{ padding: "9px 14px", textAlign: "right", color: T.textMute }}>{p.totalDeposited.toFixed(1)}</td>
                        <td style={{ padding: "9px 14px", textAlign: "right", color: T.textMute }}>{p.totalWagered.toFixed(1)}</td>
                        <td style={{ padding: "9px 14px", textAlign: "right", color: T.textMute }}>{p.betOnWins.toFixed(1)}</td>
                        <td style={{ padding: "9px 14px", textAlign: "right", color: C.green }}>{p.totalWon.toFixed(1)}</td>
                        <td style={{ padding: "9px 14px", textAlign: "right", color: C.red }}>{p.totalLost.toFixed(1)}</td>
                        <td style={{ padding: "9px 14px", textAlign: "right", fontWeight: 700, color: p.netProfitLoss >= 0 ? C.green : C.red }}>
                          {p.netProfitLoss >= 0 ? "+" : ""}{p.netProfitLoss.toFixed(1)}
                        </td>
                        <td style={{ padding: "9px 14px", textAlign: "right", color: T.textMute }}>{p.flips} ({p.wins}W)</td>
                        <td style={{ padding: "9px 14px", textAlign: "right", color: T.textMute, whiteSpace: "nowrap" }}>{timeAgo(p.lastPlayedAt)}</td>
                        <td style={{ padding: "9px 14px", textAlign: "right", whiteSpace: "nowrap" }}>
                          <button
                            onClick={() => purgeMinigamesFlipHistory(p.identityKey)}
                            disabled={raffleActionLoading === `minigames_purge_${p.identityKey}`}
                            title="Clears this identity's win/loss flip history only — balance, deposits, cash-outs, and credit history are untouched."
                            style={{ background: "transparent", border: `1px solid ${C.red}`, color: C.red, borderRadius: 6, padding: "4px 8px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}
                          >
                            {raffleActionLoading === `minigames_purge_${p.identityKey}` ? "Clearing…" : "🗑 Clear Flips"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "14px 16px", marginBottom: "1rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: T.creamMute }}>🔒 Provably Fair — Active Seed</div>
                <div style={{ fontSize: 10, color: T.textMute, maxWidth: 480, lineHeight: 1.5 }}>
                  Every flip resolves as HMAC-SHA256(serverSeed, clientSeed:nonce). Only the seed's
                  hash is shown while it's live — the raw seed is revealed once it rotates, at which
                  point anyone can recompute it and confirm every flip below.
                </div>
              </div>
              {minigamesAdmin?.activeSeed ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 10, color: T.textMute, marginBottom: 3 }}>Server Seed Hash (committed)</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontFamily: "monospace", fontSize: 12, color: T.cream }} title={minigamesAdmin.activeSeed.serverSeedHash}>
                        {shortHash(minigamesAdmin.activeSeed.serverSeedHash)}
                      </span>
                      <button
                        onClick={() => copyToClipboard(minigamesAdmin.activeSeed.serverSeedHash)}
                        style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.creamMute, borderRadius: 5, padding: "2px 6px", fontSize: 10, cursor: "pointer" }}
                      >
                        {copiedHash === minigamesAdmin.activeSeed.serverSeedHash ? "✓" : "Copy"}
                      </button>
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: T.textMute, marginBottom: 3 }}>Flips Used (nonce)</div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: T.cream }}>{minigamesAdmin.activeSeed.flipsUsed}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: T.textMute, marginBottom: 3 }}>Committed</div>
                    <div style={{ fontSize: 13, color: T.textSub }}>{timeAgo(minigamesAdmin.activeSeed.createdAt)}</div>
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: T.textMute }}>No active seed yet — mints on the first flip.</div>
              )}

              <div style={{ marginTop: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <button
                    onClick={() => setShowSeedHistory((v) => !v)}
                    style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.creamMute, borderRadius: 6, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                  >
                    {showSeedHistory ? "▾" : "▸"} Revealed Seed History {(minigamesAdmin?.seedHistory ?? []).length > 0 && `(${minigamesAdmin.seedHistory.length})`}
                  </button>
                  <button
                    onClick={rotateMinigamesSeed}
                    disabled={raffleActionLoading === "minigames_rotate_seed"}
                    style={{ background: "transparent", border: `1px solid #dc2626`, color: "#dc2626", borderRadius: 6, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                  >
                    {raffleActionLoading === "minigames_rotate_seed" ? "Rotating…" : "🔄 Rotate Seed Now"}
                  </button>
                  <span style={{ fontSize: 10, color: T.textMute }}>
                    Auto-rotates every {minigamesAdmin?.config?.seedRotateAfterFlips ?? "—"} flips
                  </span>
                </div>
                {showSeedHistory && (
                  <div style={{ marginTop: 10, maxHeight: 220, overflowY: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                      <thead>
                        <tr>
                          {["Raw Seed (revealed)", "Hash", "Flips", "Revealed"].map((h) => (
                            <th key={h} style={{ textAlign: "left", padding: "6px 10px", color: T.creamMute, fontWeight: 700, fontSize: 10, textTransform: "uppercase", borderBottom: `1px solid ${T.border}`, background: T.surfaceAlt }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(minigamesAdmin?.seedHistory ?? []).length === 0 ? (
                          <tr><td colSpan={4} style={{ padding: "14px", textAlign: "center", color: T.textMute }}>No seeds have rotated out yet.</td></tr>
                        ) : (minigamesAdmin.seedHistory as RevealedSeedEntry[]).map((s) => (
                          <tr key={s.serverSeedHash} style={{ borderBottom: `1px solid ${T.borderSub}` }}>
                            <td style={{ padding: "7px 10px" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <span style={{ fontFamily: "monospace" }} title={s.serverSeed}>{shortHash(s.serverSeed)}</span>
                                <button
                                  onClick={() => copyToClipboard(s.serverSeed)}
                                  style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.creamMute, borderRadius: 5, padding: "2px 6px", fontSize: 10, cursor: "pointer" }}
                                >
                                  {copiedHash === s.serverSeed ? "✓" : "Copy"}
                                </button>
                              </div>
                            </td>
                            <td style={{ padding: "7px 10px" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <span style={{ fontFamily: "monospace", color: T.textMute }} title={s.serverSeedHash}>{shortHash(s.serverSeedHash)}</span>
                                <button
                                  onClick={() => copyToClipboard(s.serverSeedHash)}
                                  style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.creamMute, borderRadius: 5, padding: "2px 6px", fontSize: 10, cursor: "pointer" }}
                                >
                                  {copiedHash === s.serverSeedHash ? "✓" : "Copy"}
                                </button>
                              </div>
                            </td>
                            <td style={{ padding: "7px 10px", color: T.textSub }}>{s.finalNonce}</td>
                            <td style={{ padding: "7px 10px", color: T.textMute }}>{timeAgo(s.revealedAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden", marginBottom: "1rem" }}>
              <div style={{ padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, borderBottom: `1px solid ${T.border}` }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: T.creamMute }}>Recent Flips — HMAC Proof</div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <input
                    placeholder="Search FID or wallet…"
                    value={flipsSearch}
                    onChange={(e) => setFlipsSearch(e.target.value)}
                    style={{ background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 9px", fontSize: 11, color: T.cream, minWidth: 180 }}
                  />
                  <span style={{ fontSize: 11, color: T.textMute, whiteSpace: "nowrap" }}>
                    {(() => {
                      const q = flipsSearch.trim().toLowerCase();
                      const all = minigamesAdmin?.recentFlips ?? [];
                      const filteredCount = all.filter((f: any) =>
                        !q || f.identityKey?.toLowerCase().includes(q)
                      ).length;
                      return `${filteredCount} of ${all.length} rows`;
                    })()}
                  </span>
                </div>
              </div>
              <div style={{ overflowX: "auto", maxHeight: 320, overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr>
                      {["Identity", "Bet", "Choice → Result", "Outcome", "Nonce", "Client Seed", "Server Seed Hash", "Time"].map((h) => (
                        <th key={h} style={{ textAlign: "left", padding: "9px 14px", color: T.creamMute, fontWeight: 700, fontSize: 10, textTransform: "uppercase", borderBottom: `1px solid ${T.border}`, background: T.surfaceAlt, whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const q = flipsSearch.trim().toLowerCase();
                      const rows = (minigamesAdmin?.recentFlips ?? []).filter((f: any) =>
                        !q || f.identityKey?.toLowerCase().includes(q)
                      );
                      if (rows.length === 0) {
                        return <tr><td colSpan={8} style={{ padding: "20px 14px", textAlign: "center", color: T.textMute }}>{q ? "No matching flips." : "No flips yet."}</td></tr>;
                      }
                      return (rows as CoinTossFlipEntry[]).map((f) => (
                      <tr key={f.id} style={{ borderBottom: `1px solid ${T.borderSub}` }}>
                        <td style={{ padding: "8px 14px", fontFamily: "monospace" }}>{f.identityKey}</td>
                        <td style={{ padding: "8px 14px" }}>{f.betDegen} DEGEN</td>
                        <td style={{ padding: "8px 14px", textTransform: "capitalize" }}>{f.choice} → {f.result}</td>
                        <td style={{ padding: "8px 14px", fontWeight: 700, color: f.won ? C.green : C.red }}>
                          {f.won ? `+${f.payoutDegen.toFixed(2)}` : "Lost"}
                          {f.won && f.feeTakenDegen > 0 && (
                            <span style={{ fontWeight: 400, color: T.textMute }}> ({f.feeTakenDegen.toFixed(2)} fee)</span>
                          )}
                        </td>
                        <td style={{ padding: "8px 14px", color: T.textSub }}>{f.nonce}</td>
                        <td style={{ padding: "8px 14px", fontFamily: "monospace", color: T.textSub }}>{f.clientSeed}</td>
                        <td style={{ padding: "8px 14px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontFamily: "monospace", color: T.textMute }} title={f.serverSeedHash}>{shortHash(f.serverSeedHash)}</span>
                            <button
                              onClick={() => copyToClipboard(f.serverSeedHash)}
                              style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.creamMute, borderRadius: 5, padding: "1px 5px", fontSize: 9, cursor: "pointer" }}
                            >
                              {copiedHash === f.serverSeedHash ? "✓" : "Copy"}
                            </button>
                          </div>
                        </td>
                        <td style={{ padding: "8px 14px", color: T.textMute, whiteSpace: "nowrap" }}>{timeAgo(f.ts)}</td>
                      </tr>
                      ));
                    })()}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ── Player Flip History — on-demand lookup of one player's full
                per-identity flip log (up to 500, via getFlipsForIdentity),
                separate from the shared global feed above which is capped
                at 100 across all players combined ── */}
            <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden", marginBottom: "1rem" }}>
              <div style={{ padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, borderBottom: `1px solid ${T.border}` }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: T.creamMute }}>Player Flip History</div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <input
                    placeholder="FID or wallet…"
                    value={playerHistoryQuery}
                    onChange={(e) => setPlayerHistoryQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") lookupPlayerFlipHistory(); }}
                    style={{ background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 9px", fontSize: 11, color: T.cream, minWidth: 180 }}
                  />
                  <button
                    onClick={lookupPlayerFlipHistory}
                    disabled={playerHistoryLoading || !playerHistoryQuery.trim()}
                    style={{ background: "#dc2626", color: "#fff", border: "none", borderRadius: 6, padding: "6px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                  >
                    {playerHistoryLoading ? "Searching…" : "Search"}
                  </button>
                  {playerHistoryResults !== null && (
                    <button
                      onClick={() => { setPlayerHistoryResults(null); setPlayerHistoryIdentityKey(null); setPlayerHistoryError(null); setPlayerHistoryQuery(""); }}
                      style={{ background: "transparent", color: T.creamMute, border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                    >
                      ✕ Clear
                    </button>
                  )}
                </div>
              </div>

              {playerHistoryError && (
                <div style={{ padding: "14px", color: "#dc2626", fontSize: 12 }}>{playerHistoryError}</div>
              )}

              {playerHistoryResults === null && !playerHistoryError && (
                <div style={{ padding: "20px 14px", textAlign: "center", color: T.textMute, fontSize: 12 }}>
                  Enter an FID or wallet above and hit Search to pull that player's full flip history.
                </div>
              )}

              {playerHistoryResults !== null && (
                <>
                  <div style={{ padding: "8px 14px", fontSize: 11, color: T.textMute, borderBottom: `1px solid ${T.borderSub}` }}>
                    {playerHistoryIdentityKey} — {playerHistoryResults.length} flip{playerHistoryResults.length === 1 ? "" : "s"}
                  </div>
                  <div style={{ overflowX: "auto", maxHeight: 320, overflowY: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                      <thead>
                        <tr>
                          {["Bet", "Choice → Result", "Outcome", "Nonce", "Client Seed", "Server Seed Hash", "Time"].map((h) => (
                            <th key={h} style={{ textAlign: "left", padding: "9px 14px", color: T.creamMute, fontWeight: 700, fontSize: 10, textTransform: "uppercase", borderBottom: `1px solid ${T.border}`, background: T.surfaceAlt, whiteSpace: "nowrap" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {playerHistoryResults.length === 0 ? (
                          <tr><td colSpan={7} style={{ padding: "20px 14px", textAlign: "center", color: T.textMute }}>No flips for this player yet.</td></tr>
                        ) : (
                          playerHistoryResults.map((f, i) => (
                            <tr key={f.id ?? i} style={{ borderBottom: `1px solid ${T.borderSub}` }}>
                              <td style={{ padding: "8px 14px" }}>{f.betDegen} DEGEN</td>
                              <td style={{ padding: "8px 14px", textTransform: "capitalize" }}>{f.choice} → {f.result}</td>
                              <td style={{ padding: "8px 14px", fontWeight: 700, color: f.won ? C.green : C.red }}>
                                {f.won ? `+${f.payoutDegen.toFixed(2)}` : "Lost"}
                                {f.won && f.feeTakenDegen > 0 && (
                                  <span style={{ fontWeight: 400, color: T.textMute }}> ({f.feeTakenDegen.toFixed(2)} fee)</span>
                                )}
                              </td>
                              <td style={{ padding: "8px 14px", color: T.textSub }}>{f.nonce}</td>
                              <td style={{ padding: "8px 14px", fontFamily: "monospace", color: T.textSub }}>{f.clientSeed}</td>
                              <td style={{ padding: "8px 14px" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                  <span style={{ fontFamily: "monospace", color: T.textMute }} title={f.serverSeedHash}>{shortHash(f.serverSeedHash)}</span>
                                  <button
                                    onClick={() => copyToClipboard(f.serverSeedHash)}
                                    style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.creamMute, borderRadius: 5, padding: "1px 5px", fontSize: 9, cursor: "pointer" }}
                                  >
                                    {copiedHash === f.serverSeedHash ? "✓" : "Copy"}
                                  </button>
                                </div>
                              </td>
                              <td style={{ padding: "8px 14px", color: T.textMute, whiteSpace: "nowrap" }}>{timeAgo(f.ts)}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>

        {/* ── Mini Games: Dice ── */}
        <SectionLabel dark={dark} accent="#7c3aed">🎲 Mini Games — Dice</SectionLabel>

        {(minigamesAdmin?.diceAlerts ?? []).length > 0 && (
          <div style={{ background: C.redDim, border: `1px solid ${C.red}`, borderRadius: 10, padding: "10px 14px", marginBottom: "1rem" }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: C.red, marginBottom: 4 }}>⚠ Circuit-breaker alerts</div>
            {minigamesAdmin.diceAlerts.slice(0, 5).map((a: any) => (
              <div key={a.id} style={{ fontSize: 11, color: T.textMute }}>{timeAgo(a.ts)} — {a.message}</div>
            ))}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: "1rem" }}>
          {[
            { key: "status", label: "Status", value: minigamesAdmin?.diceConfig?.enabled ? "Live" : "Paused", color: minigamesAdmin?.diceConfig?.enabled ? C.green : C.red },
            { key: "netAllTime", label: "House Net (all-time)", value: (minigamesAdmin?.diceStats?.allTime?.houseNet ?? 0).toFixed(1), color: (minigamesAdmin?.diceStats?.allTime?.houseNet ?? 0) >= 0 ? C.green : C.red },
            { key: "net24h", label: "House Net (24h)", value: (minigamesAdmin?.diceStats?.last24h?.houseNet ?? 0).toFixed(1), color: (minigamesAdmin?.diceStats?.last24h?.houseNet ?? 0) >= 0 ? C.green : C.red },
            { key: "winRate", label: "Win Rate", value: `${(minigamesAdmin?.diceStats?.allTime?.winRatePercent ?? 0).toFixed(1)}%`, color: C.blue },
            { key: "rolls", label: "Total Rolls", value: minigamesAdmin?.diceStats?.allTime?.rolls ?? 0, color: T.cream },
          ].map((s) => (
            <div key={s.key} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "12px 14px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: T.creamMute }}>{s.label}</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: s.color, marginTop: 4 }}>{s.value}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 10, marginBottom: "1rem" }}>
          <button
            onClick={toggleDiceEnabled}
            disabled={raffleActionLoading === "dice_toggle"}
            style={{
              background: minigamesAdmin?.diceConfig?.enabled ? C.red : C.green, color: "#fff", border: "none", borderRadius: 8,
              padding: "8px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer",
            }}
          >
            {minigamesAdmin?.diceConfig?.enabled ? "⏸ Pause Dice" : "▶ Resume Dice"}
          </button>
          <button onClick={loadMinigamesAdmin} style={{ background: "transparent", color: T.creamMute, border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
            ↺ Refresh
          </button>
          <button
            onClick={rotateDiceSeed}
            disabled={raffleActionLoading === "dice_rotate_seed"}
            style={{ background: "transparent", color: "#7c3aed", border: "1px solid #7c3aed", borderRadius: 8, padding: "8px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
          >
            {raffleActionLoading === "dice_rotate_seed" ? "Rotating…" : "🔄 Rotate Seed"}
          </button>
        </div>

        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "14px 16px", marginBottom: "1rem" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: T.creamMute, marginBottom: 10 }}>Config</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
            {[
              { key: "minBetDegen", label: "Min bet (DEGEN)", hint: "Smallest bet a player can place per roll." },
              { key: "maxBetDegen", label: "Max bet (DEGEN)", hint: "Largest bet a player can place per roll." },
              { key: "maxBetPercentOfTreasury", label: "Max bet % of treasury", hint: "Bet is also capped at this % of the live treasury, whichever is lower than Max bet." },
              { key: "houseEdgePercent", label: "House edge %", hint: "House's average take per bet, e.g. 2 = house keeps ~2% regardless of target picked." },
              { key: "minWinChancePercent", label: "Min win chance %", hint: "Lowest win chance a player can pick. Picking low chance = high multiplier — this floor caps that multiplier from going too high." },
              { key: "maxWinChancePercent", label: "Max win chance %", hint: "Highest win chance a player can pick. Stops near-guaranteed, near-1x payout bets that are pointless to offer." },
              { key: "maxMultiplier", label: "Max multiplier (x)", hint: "Hard ceiling on payout multiplier no matter what chance is picked — protects the pool from an extreme long-shot bet." },
              { key: "maxPayoutDegen", label: "Max payout per roll (DEGEN)", hint: "Hard ceiling on payout for a single roll, regardless of bet size × multiplier." },
              { key: "lossCircuitBreakerDegen", label: "24h loss circuit-breaker (DEGEN)", hint: "Dice auto-pauses if rolling 24h house losses hit this — separate bucket from Coin Toss's breaker." },
              { key: "maxRollsPerMinutePerUser", label: "Max rolls/min/user", hint: "Rate limit — rolls a single player can place per minute." },
              { key: "seedRotateAfterRolls", label: "Auto-rotate seed after N rolls", hint: "Provably-fair seed auto-rotates (and reveals) once it's backed this many rolls." },
            ].map((f) => {
              const hintKey = `dice:${f.key}`;
              const isOpen = openConfigHint === hintKey;
              return (
              <label key={f.key} data-config-hint style={{ fontSize: 11, color: T.creamMute, position: "relative", display: "block" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  {f.label}
                  <button
                    type="button"
                    onClick={(e) => { e.preventDefault(); setOpenConfigHint(isOpen ? null : hintKey); }}
                    style={{
                      width: 14, height: 14, borderRadius: "50%", border: `1px solid ${T.border}`, background: "transparent",
                      color: T.textMute, fontSize: 9, fontWeight: 700, lineHeight: "12px", cursor: "pointer", padding: 0,
                      display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                    }}
                  >
                    ?
                  </button>
                </span>
                {isOpen && (
                  <div style={{
                    position: "absolute", top: "100%", left: 0, marginTop: 4, zIndex: 20, width: 220,
                    background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 10px",
                    fontSize: 10, fontWeight: 400, color: T.textSub, lineHeight: 1.4, boxShadow: "0 4px 14px rgba(0,0,0,0.35)",
                  }}>
                    {f.hint}
                  </div>
                )}
                <input
                  type="number"
                  value={diceConfigDraft[f.key] ?? ""}
                  onChange={(e) => setDiceConfigDraft((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  style={{
                    display: "block", width: "100%", marginTop: 4, background: T.surfaceAlt, color: T.cream,
                    border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 8px", fontSize: 13,
                  }}
                />
              </label>
              );
            })}
          </div>
          <button
            onClick={saveDiceConfig}
            disabled={raffleActionLoading === "dice_config"}
            style={{ marginTop: 12, background: "#7c3aed", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
          >
            {raffleActionLoading === "dice_config" ? "Saving…" : "Save Config"}
          </button>
        </div>

        {/* ── Player Stats — only identities that have actually rolled ── */}
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden", marginBottom: "1.5rem" }}>
          <div style={{ padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, borderBottom: `1px solid ${T.border}` }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.creamMute }}>
              Player Stats — {(minigamesAdmin?.dicePlayerStats ?? []).length} players
            </div>
          </div>
          <div style={{ maxHeight: 360, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr>
                  {["Identity", "Balance", "Total Wagered", "Bet on Wins", "Won", "Lost", "Net P/L", "Rolls", "Last Played", "Actions"].map((h, i) => (
                    <th key={h} style={{ textAlign: i === 0 ? "left" : "right", padding: "9px 14px", color: T.creamMute, fontWeight: 700, fontSize: 10, textTransform: "uppercase", borderBottom: `1px solid ${T.border}`, background: T.surfaceAlt, position: "sticky", top: 0 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(minigamesAdmin?.dicePlayerStats ?? []).length === 0 ? (
                  <tr><td colSpan={10} style={{ padding: "20px 14px", textAlign: "center", color: T.textMute }}>No one has played Dice yet.</td></tr>
                ) : (minigamesAdmin.dicePlayerStats as DicePlayerStats[]).map((p) => (
                  <tr key={p.identityKey} style={{ borderBottom: `1px solid ${T.borderSub}` }}>
                    <td style={{ padding: "9px 14px", fontFamily: "monospace" }}>{p.identityKey}</td>
                    <td style={{ padding: "9px 14px", textAlign: "right", fontWeight: 700, color: T.cream }}>{p.balance.toFixed(1)}</td>
                    <td style={{ padding: "9px 14px", textAlign: "right", color: T.textMute }}>{p.totalWagered.toFixed(1)}</td>
                    <td style={{ padding: "9px 14px", textAlign: "right", color: T.textMute }}>{p.betOnWins.toFixed(1)}</td>
                    <td style={{ padding: "9px 14px", textAlign: "right", color: C.green }}>{p.totalWon.toFixed(1)}</td>
                    <td style={{ padding: "9px 14px", textAlign: "right", color: C.red }}>{p.totalLost.toFixed(1)}</td>
                    <td style={{ padding: "9px 14px", textAlign: "right", fontWeight: 700, color: p.netProfitLoss >= 0 ? C.green : C.red }}>
                      {p.netProfitLoss >= 0 ? "+" : ""}{p.netProfitLoss.toFixed(1)}
                    </td>
                    <td style={{ padding: "9px 14px", textAlign: "right", color: T.textMute }}>{p.rolls} ({p.wins}W)</td>
                    <td style={{ padding: "9px 14px", textAlign: "right", color: T.textMute, whiteSpace: "nowrap" }}>{timeAgo(p.lastPlayedAt)}</td>
                    <td style={{ padding: "9px 14px", textAlign: "right", whiteSpace: "nowrap" }}>
                      <button
                        onClick={() => purgeDiceRollHistory(p.identityKey)}
                        disabled={raffleActionLoading === `dice_purge_${p.identityKey}`}
                        title="Clears this identity's win/loss roll history only — balance, deposits, cash-outs, and credit history are untouched."
                        style={{ background: "transparent", border: "1px solid #dc2626", color: "#dc2626", borderRadius: 6, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                      >
                        {raffleActionLoading === `dice_purge_${p.identityKey}` ? "…" : "Purge"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Provably Fair — Active Seed (Dice) — own commitment from Coin
            Toss's above: separate serverSeed/hash, separate nonce, separate
            rotation cadence (seedRotateAfterRolls). Only the per-identity
            clientSeed is shared between the two games. ── */}
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "14px 16px", marginBottom: "1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.creamMute }}>🔒 Provably Fair — Active Seed (Dice)</div>
            <div style={{ fontSize: 10, color: T.textMute, maxWidth: 480, lineHeight: 1.5 }}>
              Every roll resolves as HMAC-SHA256(serverSeed, "dice:"+clientSeed+":"+nonce) → 1–100. Only the seed's
              hash is shown while it's live — the raw seed is revealed once it rotates, at which
              point anyone can recompute it and confirm every roll below. This seed is independent
              of Coin Toss's — rotating one never touches the other.
            </div>
          </div>
          {minigamesAdmin?.diceActiveSeed ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
              <div>
                <div style={{ fontSize: 10, color: T.textMute, marginBottom: 3 }}>Server Seed Hash (committed)</div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontFamily: "monospace", fontSize: 12, color: T.cream }} title={minigamesAdmin.diceActiveSeed.serverSeedHash}>
                    {shortHash(minigamesAdmin.diceActiveSeed.serverSeedHash)}
                  </span>
                  <button
                    onClick={() => copyToClipboard(minigamesAdmin.diceActiveSeed.serverSeedHash)}
                    style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.creamMute, borderRadius: 5, padding: "2px 6px", fontSize: 10, cursor: "pointer" }}
                  >
                    {copiedHash === minigamesAdmin.diceActiveSeed.serverSeedHash ? "✓" : "Copy"}
                  </button>
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: T.textMute, marginBottom: 3 }}>Rolls Used (nonce)</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: T.cream }}>{minigamesAdmin.diceActiveSeed.rollsUsed}</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: T.textMute, marginBottom: 3 }}>Committed</div>
                <div style={{ fontSize: 13, color: T.textSub }}>{timeAgo(minigamesAdmin.diceActiveSeed.createdAt)}</div>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: T.textMute }}>No active seed yet — mints on the first roll.</div>
          )}

          <div style={{ marginTop: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <button
                onClick={() => setShowDiceSeedHistory((v) => !v)}
                style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.creamMute, borderRadius: 6, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
              >
                {showDiceSeedHistory ? "▾" : "▸"} Revealed Seed History {(minigamesAdmin?.diceSeedHistory ?? []).length > 0 && `(${minigamesAdmin.diceSeedHistory.length})`}
              </button>
              <button
                onClick={rotateDiceSeed}
                disabled={raffleActionLoading === "dice_rotate_seed"}
                style={{ background: "transparent", color: "#7c3aed", border: "1px solid #7c3aed", borderRadius: 6, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
              >
                {raffleActionLoading === "dice_rotate_seed" ? "Rotating…" : "🔄 Rotate Seed Now"}
              </button>
              <span style={{ fontSize: 10, color: T.textMute }}>
                Auto-rotates every {minigamesAdmin?.diceConfig?.seedRotateAfterRolls ?? "—"} rolls
              </span>
            </div>
            {showDiceSeedHistory && (
              <div style={{ marginTop: 10, maxHeight: 220, overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                  <thead>
                    <tr>
                      {["Raw Seed (revealed)", "Hash", "Rolls", "Revealed"].map((h) => (
                        <th key={h} style={{ textAlign: "left", padding: "6px 10px", color: T.creamMute, fontWeight: 700, fontSize: 10, textTransform: "uppercase", borderBottom: `1px solid ${T.border}`, background: T.surfaceAlt }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(minigamesAdmin?.diceSeedHistory ?? []).length === 0 ? (
                      <tr><td colSpan={4} style={{ padding: "14px", textAlign: "center", color: T.textMute }}>No seeds have rotated out yet.</td></tr>
                    ) : (minigamesAdmin.diceSeedHistory as RevealedSeedEntry[]).map((s) => (
                      <tr key={s.serverSeedHash} style={{ borderBottom: `1px solid ${T.borderSub}` }}>
                        <td style={{ padding: "7px 10px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontFamily: "monospace" }} title={s.serverSeed}>{shortHash(s.serverSeed)}</span>
                            <button
                              onClick={() => copyToClipboard(s.serverSeed)}
                              style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.creamMute, borderRadius: 5, padding: "2px 6px", fontSize: 10, cursor: "pointer" }}
                            >
                              {copiedHash === s.serverSeed ? "✓" : "Copy"}
                            </button>
                          </div>
                        </td>
                        <td style={{ padding: "7px 10px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontFamily: "monospace", color: T.textMute }} title={s.serverSeedHash}>{shortHash(s.serverSeedHash)}</span>
                            <button
                              onClick={() => copyToClipboard(s.serverSeedHash)}
                              style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.creamMute, borderRadius: 5, padding: "2px 6px", fontSize: 10, cursor: "pointer" }}
                            >
                              {copiedHash === s.serverSeedHash ? "✓" : "Copy"}
                            </button>
                          </div>
                        </td>
                        <td style={{ padding: "7px 10px", color: T.textSub }}>{s.finalNonce}</td>
                        <td style={{ padding: "7px 10px", color: T.textMute }}>{timeAgo(s.revealedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* ── Recent Rolls — HMAC Proof — own feed from Coin Toss's Recent
            Flips above: sourced from getRecentDiceRolls, capped at 100
            across all players, independent of the Coin Toss flip feed. ── */}
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden", marginBottom: "1rem" }}>
          <div style={{ padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, borderBottom: `1px solid ${T.border}` }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.creamMute }}>Recent Rolls — HMAC Proof</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input
                placeholder="Search FID or wallet…"
                value={rollsSearch}
                onChange={(e) => setRollsSearch(e.target.value)}
                style={{ background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 9px", fontSize: 11, color: T.cream, minWidth: 180 }}
              />
              <span style={{ fontSize: 11, color: T.textMute, whiteSpace: "nowrap" }}>
                {(() => {
                  const q = rollsSearch.trim().toLowerCase();
                  const all = minigamesAdmin?.recentDiceRolls ?? [];
                  const filteredCount = all.filter((r: any) =>
                    !q || r.identityKey?.toLowerCase().includes(q)
                  ).length;
                  return `${filteredCount} of ${all.length} rows`;
                })()}
              </span>
            </div>
          </div>
          <div style={{ overflowX: "auto", maxHeight: 320, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr>
                  {["Identity", "Bet", "Target", "Roll", "Outcome", "Chance / Mult", "Nonce", "Client Seed", "Server Seed Hash", "Time"].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "9px 14px", color: T.creamMute, fontWeight: 700, fontSize: 10, textTransform: "uppercase", borderBottom: `1px solid ${T.border}`, background: T.surfaceAlt, whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const q = rollsSearch.trim().toLowerCase();
                  const rows = (minigamesAdmin?.recentDiceRolls ?? []).filter((r: any) =>
                    !q || r.identityKey?.toLowerCase().includes(q)
                  );
                  if (rows.length === 0) {
                    return <tr><td colSpan={10} style={{ padding: "20px 14px", textAlign: "center", color: T.textMute }}>{q ? "No matching rolls." : "No rolls yet."}</td></tr>;
                  }
                  return (rows as DiceRollEntry[]).map((r) => (
                  <tr key={r.id} style={{ borderBottom: `1px solid ${T.borderSub}` }}>
                    <td style={{ padding: "8px 14px", fontFamily: "monospace" }}>{r.identityKey}</td>
                    <td style={{ padding: "8px 14px" }}>{r.betDegen} DEGEN</td>
                    <td style={{ padding: "8px 14px", textTransform: "capitalize" }}>{r.direction} {r.target}</td>
                    <td style={{ padding: "8px 14px" }}>{r.roll}</td>
                    <td style={{ padding: "8px 14px", fontWeight: 700, color: r.won ? C.green : C.red }}>
                      {r.won ? `+${r.payoutDegen.toFixed(2)}` : "Lost"}
                    </td>
                    <td style={{ padding: "8px 14px", color: T.textSub }}>{r.winChancePercent.toFixed(1)}% / {r.multiplier.toFixed(2)}x</td>
                    <td style={{ padding: "8px 14px", color: T.textSub }}>{r.nonce}</td>
                    <td style={{ padding: "8px 14px", fontFamily: "monospace", color: T.textSub }}>{r.clientSeed}</td>
                    <td style={{ padding: "8px 14px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontFamily: "monospace", color: T.textMute }} title={r.serverSeedHash}>{shortHash(r.serverSeedHash)}</span>
                        <button
                          onClick={() => copyToClipboard(r.serverSeedHash)}
                          style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.creamMute, borderRadius: 5, padding: "1px 5px", fontSize: 9, cursor: "pointer" }}
                        >
                          {copiedHash === r.serverSeedHash ? "✓" : "Copy"}
                        </button>
                      </div>
                    </td>
                    <td style={{ padding: "8px 14px", color: T.textMute, whiteSpace: "nowrap" }}>{timeAgo(r.ts)}</td>
                  </tr>
                  ));
                })()}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Player Roll History — on-demand lookup of one player's full
            per-identity roll log (up to 500, via getDiceRollsForIdentity),
            separate from the shared global feed above which is capped at
            100 across all players combined. Mirrors Player Flip History
            for Coin Toss, but never mixes the two games' rows. ── */}
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden", marginBottom: "1.5rem" }}>
          <div style={{ padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, borderBottom: `1px solid ${T.border}` }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.creamMute }}>Player Roll History</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input
                placeholder="FID or wallet…"
                value={playerRollHistoryQuery}
                onChange={(e) => setPlayerRollHistoryQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") lookupPlayerRollHistory(); }}
                style={{ background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 9px", fontSize: 11, color: T.cream, minWidth: 180 }}
              />
              <button
                onClick={lookupPlayerRollHistory}
                disabled={playerRollHistoryLoading || !playerRollHistoryQuery.trim()}
                style={{ background: "#7c3aed", color: "#fff", border: "none", borderRadius: 6, padding: "6px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
              >
                {playerRollHistoryLoading ? "Searching…" : "Search"}
              </button>
              {playerRollHistoryResults !== null && (
                <button
                  onClick={() => { setPlayerRollHistoryResults(null); setPlayerRollHistoryIdentityKey(null); setPlayerRollHistoryError(null); setPlayerRollHistoryQuery(""); }}
                  style={{ background: "transparent", color: T.creamMute, border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                >
                  ✕ Clear
                </button>
              )}
            </div>
          </div>

          {playerRollHistoryError && (
            <div style={{ padding: "14px", color: "#dc2626", fontSize: 12 }}>{playerRollHistoryError}</div>
          )}

          {playerRollHistoryResults === null && !playerRollHistoryError && (
            <div style={{ padding: "20px 14px", textAlign: "center", color: T.textMute, fontSize: 12 }}>
              Enter an FID or wallet above and hit Search to pull that player's full roll history.
            </div>
          )}

          {playerRollHistoryResults !== null && (
            <>
              <div style={{ padding: "8px 14px", fontSize: 11, color: T.textMute, borderBottom: `1px solid ${T.borderSub}` }}>
                {playerRollHistoryIdentityKey} — {playerRollHistoryResults.length} roll{playerRollHistoryResults.length === 1 ? "" : "s"}
              </div>
              <div style={{ overflowX: "auto", maxHeight: 320, overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr>
                      {["Bet", "Target", "Roll", "Outcome", "Chance / Mult", "Nonce", "Client Seed", "Server Seed Hash", "Time"].map((h) => (
                        <th key={h} style={{ textAlign: "left", padding: "9px 14px", color: T.creamMute, fontWeight: 700, fontSize: 10, textTransform: "uppercase", borderBottom: `1px solid ${T.border}`, background: T.surfaceAlt, whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {playerRollHistoryResults.length === 0 ? (
                      <tr><td colSpan={9} style={{ padding: "20px 14px", textAlign: "center", color: T.textMute }}>No rolls for this player yet.</td></tr>
                    ) : (
                      playerRollHistoryResults.map((r, i) => (
                        <tr key={r.id ?? i} style={{ borderBottom: `1px solid ${T.borderSub}` }}>
                          <td style={{ padding: "8px 14px" }}>{r.betDegen} DEGEN</td>
                          <td style={{ padding: "8px 14px", textTransform: "capitalize" }}>{r.direction} {r.target}</td>
                          <td style={{ padding: "8px 14px" }}>{r.roll}</td>
                          <td style={{ padding: "8px 14px", fontWeight: 700, color: r.won ? C.green : C.red }}>
                            {r.won ? `+${r.payoutDegen.toFixed(2)}` : "Lost"}
                          </td>
                          <td style={{ padding: "8px 14px", color: T.textSub }}>{r.winChancePercent.toFixed(1)}% / {r.multiplier.toFixed(2)}x</td>
                          <td style={{ padding: "8px 14px", color: T.textSub }}>{r.nonce}</td>
                          <td style={{ padding: "8px 14px", fontFamily: "monospace", color: T.textSub }}>{r.clientSeed}</td>
                          <td style={{ padding: "8px 14px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ fontFamily: "monospace", color: T.textMute }} title={r.serverSeedHash}>{shortHash(r.serverSeedHash)}</span>
                              <button
                                onClick={() => copyToClipboard(r.serverSeedHash)}
                                style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.creamMute, borderRadius: 5, padding: "1px 5px", fontSize: 9, cursor: "pointer" }}
                              >
                                {copiedHash === r.serverSeedHash ? "✓" : "Copy"}
                              </button>
                            </div>
                          </td>
                          <td style={{ padding: "8px 14px", color: T.textMute, whiteSpace: "nowrap" }}>{timeAgo(r.ts)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
          </>
        )}

        </div>
        {/* ── Overview tab content, part 2 (Transaction Log onward) ── */}
        <div style={{ display: mainTab === "overview" ? "contents" : "none" }}>
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
          <div style={{ overflowX: "auto", maxHeight: 240, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: T.surfaceAlt, position: "sticky", top: 0 }}>
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
                      background: T.surfaceAlt,
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
                  } else if (t.type === "wheel_spin") {
                    detail = t.wheelReward || "—";
                    amount = `$${(t.amountUsd || 0).toFixed(2)}`;
                    amountColor = C.green;
                  } else if (t.type === "referral_join" || t.type === "referral_checkin") {
                    detail = `→ fid ${t.toFid ?? "?"} ${shortAddr(t.toWallet) ? `(${shortAddr(t.toWallet)})` : ""}`;
                    amount = `${t.amountDegen ?? 0} DEGEN`;
                    amountColor = dark ? C.amberGlow : "#92400e";
                  } else if (t.type === "minigame_cashout") {
                    detail = "Coin Toss cash-out";
                    amount = `${t.amountDegen ?? 0} DEGEN`;
                    amountColor = "#dc2626";
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

        {/* ── Suggestions & Issues ──────────────────────────────────────────
            Fed by the in-app "Suggest / Report Issue" button — see
            app/api/suggestion/route.ts (public submit, rate-limited) and
            app/api/admin/suggestions/route.ts (this panel's data + actions).
            Every entry carries whichever identity the submitter had (fid or
            wallet), same convention as everywhere else in the dashboard. */}
        <SectionLabel dark={dark} accent="#a78bfa">
          Suggestions & Issues{newSuggestionCount > 0 ? ` (${newSuggestionCount} new)` : ""}
        </SectionLabel>
        <div ref={suggestionsPanelRef} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden", marginBottom: "1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: `1px solid ${T.borderSub}`, gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: T.textMute }}>
              {globalSearchQuery
                ? `Showing ${filteredSuggestions.length} matching "${globalSearchQuery}"`
                : `${filteredSuggestions.length} shown`}
            </span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {(["active", "new", "resolved", "archived", "all"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setSuggestionStatusFilter(f)}
                  style={{
                    fontSize: 11, fontWeight: 600, padding: "5px 10px", borderRadius: 6, cursor: "pointer",
                    border: `1px solid ${suggestionStatusFilter === f ? "#a78bfa" : T.border}`,
                    background: suggestionStatusFilter === f ? "#2e1f5e" : "transparent",
                    color: suggestionStatusFilter === f ? "#e9d5ff" : T.textMute,
                    textTransform: "capitalize",
                  }}
                >
                  {f}
                </button>
              ))}
              <span style={{ width: 1, background: T.border, margin: "0 2px" }} />
              {(["all", "suggestion", "issue"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setSuggestionTypeFilter(f)}
                  style={{
                    fontSize: 11, fontWeight: 600, padding: "5px 10px", borderRadius: 6, cursor: "pointer",
                    border: `1px solid ${suggestionTypeFilter === f ? "#a78bfa" : T.border}`,
                    background: suggestionTypeFilter === f ? "#2e1f5e" : "transparent",
                    color: suggestionTypeFilter === f ? "#e9d5ff" : T.textMute,
                  }}
                >
                  {f === "all" ? "All types" : f === "suggestion" ? "💡 Suggestion" : "🐛 Issue"}
                </button>
              ))}
            </div>
          </div>
          <div style={{ maxHeight: 420, overflowY: "auto" }}>
            {filteredSuggestions.length === 0 ? (
              <div style={{ padding: "24px 14px", textAlign: "center", color: T.textMute, fontSize: 12 }}>
                Nothing here yet.
              </div>
            ) : filteredSuggestions.map((s, i) => {
              const idStr = s.fid !== null && s.fid !== undefined ? String(s.fid) : null;
              const profile = idStr ? profiles[idStr] : undefined;
              const displayName = profile?.username ? `@${profile.username}` : (idStr ?? s.identity);
              const statusColor =
                s.status === "new" ? C.amberGlow :
                s.status === "resolved" ? C.green :
                s.status === "archived" ? T.textMute : C.blue;
              const isExpanded = expandedSuggestionId === s.id;
              const snippet = s.text.length > 70 ? `${s.text.slice(0, 70)}…` : s.text;
              return (
                <div
                  key={s.id}
                  style={{
                    borderBottom: `1px solid ${T.borderSub}`,
                    background: i % 2 === 0 ? "transparent" : T.surfaceAlt + "55",
                    opacity: s.status === "archived" ? 0.6 : 1,
                  }}
                >
                  {/* ── Collapsed summary row — click to expand/collapse ── */}
                  <div
                    onClick={() => setExpandedSuggestionId(isExpanded ? null : s.id)}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                      gap: 10,
                      flexWrap: "wrap",
                      padding: "12px 16px",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
                      <span style={{ fontSize: 10, color: T.textMute, transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform 0.15s", display: "inline-block" }}>
                        ▶
                      </span>
                      <Badge color={s.type === "issue" ? C.red : C.purple} bg={s.type === "issue" ? C.redDim : "#2e1f5e"}>
                        {s.type === "issue" ? "🐛 Issue" : "💡 Suggestion"}
                      </Badge>
                      <span
                        title="Ticket reference"
                        style={{ fontFamily: "monospace", fontSize: 10, color: T.textMute, opacity: 0.8 }}
                      >
                        #{s.id.slice(-6)}
                      </span>
                      <span style={{ fontFamily: "monospace", fontSize: 11, color: dark ? C.amberGlow : "#7c3aed" }}>
                        {displayName}
                      </span>
                      {identityActiveCounts[s.identity] > 1 && (
                        <span
                          title="This person has more than one active report"
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            padding: "1px 6px",
                            borderRadius: 999,
                            background: C.amberGlow + "22",
                            color: C.amberGlow,
                          }}
                        >
                          {identityActiveCounts[s.identity]}× reports
                        </span>
                      )}
                      <span style={{ fontSize: 10, fontWeight: 700, color: statusColor, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                        {s.status}
                      </span>
                      {!isExpanded && (
                        <span style={{ fontSize: 12, color: T.textMute, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 320 }}>
                          {snippet}
                        </span>
                      )}
                    </div>
                    <span style={{ fontSize: 11, color: T.creamMute, whiteSpace: "nowrap" }}>{timeAgo(s.ts)}</span>
                  </div>

                  {/* ── Expanded detail — full text, thread, reply, actions ── */}
                  {isExpanded && (
                    <div style={{ padding: "0 16px 14px" }}>
                      <p style={{ margin: "0 0 10px", fontSize: 13, color: T.text, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                        {s.text}
                      </p>

                      {/* Two-way thread — issue reports only. Suggestions have no
                          messages array and skip this block entirely. */}
                      {s.type === "issue" && (
                        <div style={{ marginBottom: 10 }}>
                          {(s.messages ?? []).length > 0 && (
                            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
                              {(s.messages ?? []).map((m, mi) => (
                                <div
                                  key={mi}
                                  style={{
                                    alignSelf: m.sender === "admin" ? "flex-end" : "flex-start",
                                    maxWidth: "85%",
                                    background: m.sender === "admin" ? "#2e1f5e" : T.surfaceAlt,
                                    border: `1px solid ${m.sender === "admin" ? "#a78bfa55" : T.border}`,
                                    borderRadius: 8,
                                    padding: "6px 10px",
                                  }}
                                >
                                  <div style={{ fontSize: 10, fontWeight: 700, color: m.sender === "admin" ? "#c4b5fd" : T.textMute, marginBottom: 2 }}>
                                    {m.sender === "admin" ? "You" : displayName}
                                  </div>
                                  <div style={{ fontSize: 12.5, color: T.text, whiteSpace: "pre-wrap" }}>{m.text}</div>
                                </div>
                              ))}
                            </div>
                          )}
                          {s.status !== "archived" && s.status !== "resolved" && (
                            <div style={{ display: "flex", gap: 6 }}>
                              <input
                                type="text"
                                value={replyDrafts[s.id] ?? ""}
                                onChange={(e) => setReplyDrafts((prev) => ({ ...prev, [s.id]: e.target.value }))}
                                placeholder="Reply — e.g. ask for more info…"
                                style={{
                                  flex: 1,
                                  fontSize: 12,
                                  padding: "6px 8px",
                                  borderRadius: 6,
                                  border: `1px solid ${T.border}`,
                                  background: T.surfaceAlt,
                                  color: T.text,
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    sendSuggestionReply(s.id, replyDrafts[s.id] ?? "");
                                  }
                                }}
                              />
                              <button
                                type="button"
                                disabled={suggestionActionId === s.id || !(replyDrafts[s.id] ?? "").trim()}
                                onClick={() => sendSuggestionReply(s.id, replyDrafts[s.id] ?? "")}
                                style={{
                                  fontSize: 11,
                                  fontWeight: 700,
                                  padding: "6px 12px",
                                  borderRadius: 6,
                                  cursor: "pointer",
                                  border: "1px solid #a78bfa55",
                                  background: "#2e1f5e",
                                  color: "#e9d5ff",
                                }}
                              >
                                Reply
                              </button>
                            </div>
                          )}
                        </div>
                      )}

                      <div style={{ display: "flex", gap: 6 }}>
                        {s.status !== "resolved" && (
                          <button
                            type="button"
                            disabled={suggestionActionId === s.id}
                            onClick={() => markSuggestion(s.id, "resolved")}
                            style={{ fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 6, cursor: "pointer", border: `1px solid ${C.green}55`, background: C.greenDim, color: C.green }}
                          >
                            ✓ Resolve
                          </button>
                        )}
                        {s.status === "new" && (
                          <button
                            type="button"
                            disabled={suggestionActionId === s.id}
                            onClick={() => markSuggestion(s.id, "seen")}
                            style={{ fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 6, cursor: "pointer", border: `1px solid ${C.blue}55`, background: C.blueDim, color: C.blue }}
                          >
                            Mark seen
                          </button>
                        )}
                        {s.status !== "archived" && (
                          <button
                            type="button"
                            disabled={suggestionActionId === s.id}
                            onClick={() => markSuggestion(s.id, "archived")}
                            style={{ fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 6, cursor: "pointer", border: `1px solid ${T.border}`, background: "transparent", color: T.textMute }}
                          >
                            Archive
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Webhook Event Log ── */}
        <SectionLabel dark={dark}>Webhook Event Log</SectionLabel>
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: `1px solid ${T.borderSub}` }}>
            <span style={{ fontSize: 12, color: T.textMute }}>
              {globalSearchQuery
                ? `${filteredWebhookEvents.length} matching "${globalSearchQuery}" (of ${webhookEvents.length})`
                : `Raw Farcaster/Base App events — last ${webhookEvents.length} (up to 500 fetched, 2000 stored in KV)`}
            </span>
          </div>
          <div style={{ overflowX: "auto", maxHeight: 240, overflowY: "auto" }}>
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
            <span style={{ fontSize: 12, color: T.textSub }}>
              Every known fid (pet state, notif token, or added event) —{" "}
              <strong style={{ color: T.cream, fontWeight: 700 }}>
                {notifStatusFilterActive
                  ? `${notifStatusFiltered.length}/${notifStatusUsers.length}`
                  : notifStatusUsers.length}
              </strong>{" "}
              total · <strong style={{ color: T.cream, fontWeight: 700 }}>{addedButNotifOffCount}</strong> added with notifs off
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <FilterToggle label="Notif" value={notifFilter} onChange={setNotifFilter} dark={dark} />
              <FilterToggle label="Added" value={addedFilter} onChange={setAddedFilter} dark={dark} />
              <Input
                value={userSearch}
                onChange={setUserSearch}
                placeholder="Search fid or @username…"
                style={{ width: 220, fontSize: 12, padding: "6px 10px" }}
                dark={dark}
              />
            </div>
          </div>
          <div style={{ overflowX: "auto", maxHeight: 420, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: T.surfaceAlt, position: "sticky", top: 0 }}>
                  {["FID", "Check-ins", "Credits", "Last Check-in", "Last Seen", "Notif", "Added"].map((h, i) => (
                    <th key={h} style={{
                      textAlign: i >= 1 && i <= 4 ? "right" : "left",
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
                  const filtered = notifStatusFiltered;
                  const noneReason = notifStatusQuery
                    ? `No users matching "${userSearch}".`
                    : globalSearchQuery
                    ? `No users matching global "${globalSearchQuery}".`
                    : notifFilter !== "all" || addedFilter !== "all"
                    ? "No users match this filter."
                    : "No users found.";
                  return filtered.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ padding: "24px 14px", textAlign: "center", color: T.textMute }}>
                        {noneReason}
                      </td>
                    </tr>
                  ) : filtered.map((u, i) => {
                  const profile = profiles[String(u.fid)];
                  return (
                    <tr key={u.fid} style={{
                      borderBottom: `1px solid ${T.borderSub}`,
                      background: i % 2 === 0 ? "transparent" : T.surfaceAlt + "55",
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
                          <a
                            href={`https://farcaster.xyz/${profile.username}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ fontSize: 10, color: T.textSub, textDecoration: "none", marginLeft: 6 }}
                            title={profile.displayName ?? profile.username}
                          >
                            @{profile.username}
                          </a>
                        )}
                        {u.noPetState && (
                          <span style={{ fontSize: 9, color: T.textMute, marginLeft: 6, fontStyle: "italic" }}>never opened</span>
                        )}
                      </td>
                      <td style={{ padding: "9px 14px", textAlign: "right", color: T.cream, fontVariantNumeric: "tabular-nums" }}>{u.totalCheckIns ?? 0}</td>
                      <td style={{ padding: "9px 14px", textAlign: "right" }}>
                        {((u.freeCheckinCredits ?? 0) === 0 && (u.streakSaveCredits ?? 0) === 0) ? (
                          <span style={{ color: T.textMute }}>—</span>
                        ) : (
                          <span style={{ display: "inline-flex", gap: 6, justifyContent: "flex-end" }}>
                            {(u.freeCheckinCredits ?? 0) > 0 && (
                              <Badge color={C.blue} bg={C.blueDim}>
                                🎟️ {u.freeCheckinCredits} banked
                              </Badge>
                            )}
                            {(u.streakSaveCredits ?? 0) > 0 && (
                              <Badge color={C.green} bg={C.greenDim}>
                                🛡️ {u.streakSaveCredits} banked
                              </Badge>
                            )}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: "9px 14px", textAlign: "right", color: T.cream }}>{u.lastCheckInDay ?? "never"}</td>
                      <td style={{ padding: "9px 14px", textAlign: "right", color: T.cream }}>{u.lastVisit && u.lastVisit !== "unknown" ? timeAgo(new Date(u.lastVisit).getTime()) : "unknown"}</td>
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
                    {String(u.fid).startsWith("wallet:") ? displayFid(u.fid) : `FID ${u.fid}`}
                  </button>
                  <span style={{ fontSize: 12, fontWeight: 700, color: dark ? C.amberGlow2 : "#92400e" }}>+{u.referrals?.degenEarned} DEGEN</span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {u.referrals?.referredUsers.map((r) => (
                    <span key={r.fid} style={{
                      fontSize: 11, padding: "3px 9px", borderRadius: 5,
                      background: r.status === "paid" ? C.greenDim : T.surfaceAlt,
                      color: r.status === "paid" ? C.green : T.cream,
                      border: `1px solid ${r.status === "paid" ? C.green + "66" : C.creamDim + "77"}`,
                      whiteSpace: "nowrap",
                    }}>
                      {String(r.fid).startsWith("wallet:") ? displayFid(r.fid) : `#${r.fid}`} · {r.checkins} {r.checkins === 1 ? "Check In" : "Check Ins"}
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
              dark={dark}
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
                <span style={{ fontSize: 14, fontWeight: 700, color: T.cream, fontFamily: "monospace" }}>{String(controlState.fid).startsWith("wallet:") ? displayFid(controlState.fid) : `FID ${controlState.fid}`}</span>
                <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4,
                  background: controlState.state.banned ? "#3d0000" : C.greenDim,
                  color: controlState.state.banned ? C.red : C.green,
                  fontWeight: 600,
                }}>
                  {controlState.state.banned ? "BANNED" : "Active"}
                </span>
                {controlState.referral?.referredByFid && (
                  <span style={{ fontSize: 11, fontWeight: 600, color: dark ? C.amberGlow2 : "#92400e" }}>
                    sponsored by {String(controlState.referral.referredByFid).startsWith("wallet:") ? displayFid(controlState.referral.referredByFid) : `FID ${controlState.referral.referredByFid}`}
                  </span>
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

              {(() => {
                const managedUser = users.find((u) => String(u.fid) === String(controlState.fid));
                const referred = managedUser?.referrals?.referredUsers ?? [];
                if (referred.length === 0) return null;
                return (
                  <div style={{ marginBottom: 20, background: T.surfaceAlt, borderRadius: 10, padding: "12px 14px", border: `1px solid ${T.border}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: T.creamMute, margin: 0 }}>
                        Referred Users — {referred.length}
                      </p>
                      <span style={{ fontSize: 12, fontWeight: 700, color: dark ? C.amberGlow2 : "#92400e" }}>
                        +{managedUser?.referrals?.degenEarned ?? 0} DEGEN earned
                      </span>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {referred.map((r) => (
                        <button
                          key={r.fid}
                          onClick={() => { setLookupFid(String(r.fid)); loadUserControl(String(r.fid)); }}
                          style={{
                            fontSize: 11, padding: "3px 9px", borderRadius: 5, cursor: "pointer", fontFamily: "inherit",
                            background: r.status === "paid" ? C.greenDim : T.surfaceAlt,
                            color: r.status === "paid" ? C.green : T.cream,
                            border: `1px solid ${r.status === "paid" ? C.green + "66" : C.creamDim + "77"}`,
                            whiteSpace: "nowrap",
                          }}
                          title="Open in user panel"
                        >
                          {String(r.fid).startsWith("wallet:") ? displayFid(r.fid) : `#${r.fid}`} · {r.checkins} {r.checkins === 1 ? "Check In" : "Check Ins"}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })()}

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

                {/* Left col */}
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

                  {/* Adjust stats */}
                  <div style={{ background: T.surfaceAlt, borderRadius: 10, padding: "14px" }}>
                    <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: T.creamDim, margin: "0 0 12px" }}>Adjust Stats</p>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, marginBottom: 12 }}>
                      {(["xp", "bond", "glimmer", "hunger", "happiness"] as const).map((f) => (
                        <NumberInput key={f} label={f} value={statDrafts[f]} onChange={(v) => setStatDrafts((d) => ({ ...d, [f]: v }))} dark={dark} />
                      ))}
                    </div>
                    <Btn onClick={() => runAction("adjust_stats", {
                      xp: Number(statDrafts.xp), bond: Number(statDrafts.bond),
                      glimmer: Number(statDrafts.glimmer), hunger: Number(statDrafts.hunger),
                      happiness: Number(statDrafts.happiness),
                    })} variant="default">Save Stats</Btn>
                  </div>

                  {/* Spin Wheel credits — manual correction for wins that never
                      made it into KV (e.g. a save race). See pet-route.ts's
                      wheel_spin fix for the underlying prevention; this is
                      just for patching an already-affected account. */}
                  <div style={{ background: T.surfaceAlt, borderRadius: 10, padding: "14px" }}>
                    <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: T.creamDim, margin: "0 0 12px" }}>Spin Wheel Credits</p>
                    <div style={{ display: "flex", gap: 16, marginBottom: 12 }}>
                      <div>
                        <div style={{ fontSize: 10, color: T.creamMute, marginBottom: 1 }}>🎟️ Free Check-in</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: T.cream }}>{controlState.state.freeCheckinCredits ?? 0} banked</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, color: T.creamMute, marginBottom: 1 }}>🛡️ Streak Save</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: T.cream }}>{controlState.state.streakSaveCredits ?? 0} banked</div>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <Btn onClick={() => runAction("grant_credit", { creditType: "freeCheckin", amount: 1 })} variant="default">+1 Free Check-in</Btn>
                      <Btn onClick={() => runAction("revoke_credit", { creditType: "freeCheckin", amount: 1 })} variant="red">−1 Free Check-in</Btn>
                      <Btn onClick={() => runAction("grant_credit", { creditType: "streakSave", amount: 1 })} variant="default">+1 Streak Save</Btn>
                      <Btn onClick={() => runAction("revoke_credit", { creditType: "streakSave", amount: 1 })} variant="red">−1 Streak Save</Btn>
                    </div>
                  </div>

                  {/* Coin Toss — internal balance always shown (it's just
                      their current in-game number); the deposited/won/lost/
                      net breakdown only renders once they've actually
                      placed a flip, same "played only" rule the Games tab
                      Player Stats table follows. */}
                  <div style={{ background: T.surfaceAlt, borderRadius: 10, padding: "14px" }}>
                    <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: T.creamDim, margin: "0 0 12px" }}>🪙 Coin Toss</p>
                    <div style={{ display: "flex", gap: 16, marginBottom: controlState.minigames?.coinToss ? 12 : 0 }}>
                      <div>
                        <div style={{ fontSize: 10, color: T.creamMute, marginBottom: 1 }}>Balance</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: T.cream }}>{(controlState.minigames?.coinTossBalance ?? 0).toFixed(1)} DEGEN</div>
                      </div>
                    </div>
                    {controlState.minigames?.coinToss && (
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))", gap: 10 }}>
                        {[
                          ["Deposited", controlState.minigames.coinToss.totalDeposited, T.cream],
                          ["Total Wagered", controlState.minigames.coinToss.totalWagered, T.cream],
                          ["Bet on Wins", controlState.minigames.coinToss.betOnWins, T.cream],
                          ["Won", controlState.minigames.coinToss.totalWon, C.green],
                          ["Lost", controlState.minigames.coinToss.totalLost, C.red],
                          [
                            "Net P/L",
                            controlState.minigames.coinToss.netProfitLoss,
                            controlState.minigames.coinToss.netProfitLoss >= 0 ? C.green : C.red,
                          ],
                        ].map(([label, value, color]: any) => (
                          <div key={label}>
                            <div style={{ fontSize: 10, color: T.creamMute, marginBottom: 1 }}>{label}</div>
                            <div style={{ fontSize: 13, fontWeight: 700, color }}>
                              {label === "Net P/L" && value >= 0 ? "+" : ""}{Number(value).toFixed(1)}
                            </div>
                          </div>
                        ))}
                        <div>
                          <div style={{ fontSize: 10, color: T.creamMute, marginBottom: 1 }}>Flips</div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: T.cream }}>{controlState.minigames.coinToss.flips} ({controlState.minigames.coinToss.wins}W)</div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Referral — split into two clearly separate actions */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {/* Set referrer */}
                    <div style={{ background: T.surfaceAlt, borderRadius: 10, padding: "14px", border: `1px solid ${T.border}` }}>
                      <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: dark ? C.amberGlow2 : "#7c3aed", margin: "0 0 4px" }}>Set Sponsor</p>
                      <p style={{ fontSize: 11, color: T.textSub, margin: "0 0 10px" }}>
                        {triggerRealPayout
                          ? "Runs the real referral-join flow — real DEGEN, real tx. Fails like a real join would if already registered or has activity."
                          : "Replaces their current sponsor — no need to remove first. No payout."}
                      </p>
                      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: T.textSub, margin: "0 0 10px", cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={triggerRealPayout}
                          onChange={(e) => setTriggerRealPayout(e.target.checked)}
                        />
                        Also trigger real DEGEN payout (test mode)
                      </label>
                      <div style={{ display: "flex", gap: 8 }}>
                        <Input
                          value={newReferrerFid}
                          onChange={setNewReferrerFid}
                          placeholder={String(controlState.fid).startsWith("wallet:") ? "Sponsor wallet — full 0x address" : "Sponsor FID"}
                          dark={dark}
                        />
                        <Btn
                          onClick={() => runAction("edit_referral", { newReferrerFid, triggerPayout: triggerRealPayout })}
                          disabled={!newReferrerFid}
                          variant="amber"
                        >
                          Set
                        </Btn>
                      </div>
                      {String(controlState.fid).startsWith("wallet:") && (
                        <p style={{ fontSize: 10, color: T.textMute, margin: "6px 0 0" }}>
                          Paste the full address (42 chars) — not the shortened wallet:0x1233....89893 label shown elsewhere on the dashboard.
                        </p>
                      )}
                    </div>

                    {/* Remove referral */}
                    <div style={{ background: C.redDim, borderRadius: 10, padding: "14px", border: `1px solid ${C.red}44` }}>
                      <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#fca5a5", margin: "0 0 4px" }}>Remove Sponsor</p>
                      <p style={{ fontSize: 11, color: "#e5b3b3", margin: "0 0 10px" }}>Removes the user who sponsored this player (referredBy).</p>
                      <Btn onClick={() => runAction("edit_referral", { removeReferral: true })} variant="red">✕ Remove Sponsor</Btn>
                    </div>
                  </div>

                  {/* Ban */}
                  <div style={{ background: T.surfaceAlt, borderRadius: 10, padding: "14px" }}>
                    <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: T.creamDim, margin: "0 0 6px" }}>Account Status</p>
                    <p style={{ fontSize: 11, color: T.textSub, margin: "0 0 10px" }}>Banning blocks feeding, unlocking, and check-ins.</p>
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
                  <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: T.creamDim, margin: "0 0 12px" }}>
                    Accessories — {controlState.state.accessoriesUnlocked.length} unlocked
                  </p>

                  {/* Current accessories */}
                  <div style={{ minHeight: 48, marginBottom: 14 }}>
                    {controlState.state.accessoriesUnlocked.length === 0 ? (
                      <p style={{ fontSize: 12, color: T.textSub }}>None unlocked yet.</p>
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
                        <Input value={accessoryToUnlock} onChange={setAccessoryToUnlock} placeholder="accessory id" dark={dark} />
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
                        <Input value={accessoryToRevoke} onChange={setAccessoryToRevoke} placeholder="accessory id" dark={dark} />
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
