// verify-cointoss.js
//
// Standalone provably-fair verifier for Grub's Coin Toss — no server access
// needed, this only uses the crypto module + values you copy out of the
// admin dashboard's "Revealed Seed History" and "Recent Flips" tables.
//
// Run with: node verify-cointoss.js
//
// What it checks, per flip:
//   1. sha256(serverSeed) === serverSeedHash
//        Proves the server really did commit to this exact seed BEFORE the
//        flip happened — not something picked after seeing your bet.
//   2. HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}`), first 4 bytes as
//      a uint32, mod 2 === the logged result (0 = heads, 1 = tails)
//        Proves the coin flip itself wasn't tampered with — this is the
//        exact computation lib/minigames.ts's resolveFlipOutcome() runs.

const { createHash, createHmac } = require("crypto");

// ── Fill this in from your dashboard ────────────────────────────────────
// "Revealed Seed History" gives you: serverSeed (raw), serverSeedHash.
// "Recent Flips — HMAC Proof" gives you, per flip under that seed:
//   nonce, clientSeed, and the choice→result you saw on screen.
const flipsToVerify = [
  {
    label: "self-test vector (generated just now, should PASS)",
    serverSeed: "11a47e39481d06401114be70c644360c6d031f4b351cec2730cd33fa7ed3a592",
    serverSeedHash: "07bd4145dd34dc99e6eabc735eb5d39b867eae123436fe4edb736a34b6dc7a51",
    nonce: 0,
    clientSeed: "grub-cointoss-v1",
    expectedResult: "heads",
  },
  {
    label: "flip #1 — REPLACE with your own values from the dashboard",
    serverSeed: "d56641797c2683588cc5d14138e6c2a3de3ddefc30b4d0e1ce130b9c36da15d0",       // "Raw Seed (revealed)" column
    serverSeedHash: "b9e656aae9303e99324c7a1334762013cc46d0924e4e0fddc443493310ba342a",       // "Hash" column, same row
    nonce: 0,                                // "Nonce" column, from Recent Flips
    clientSeed: "grub-cointoss-v1",          // "Client Seed" column
    expectedResult: "heads",                 // the result → half of "Choice → Result"
  },
  // Add more entries here — one per flip you want to check, they can
  // share the same serverSeed/serverSeedHash if they came from the same
  // revealed batch, just with different nonce/expectedResult.
];

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

function resolveFlip(serverSeed, clientSeed, nonce) {
  const hmac = createHmac("sha256", serverSeed).update(`${clientSeed}:${nonce}`).digest("hex");
  const int = parseInt(hmac.slice(0, 8), 16);
  return int % 2 === 0 ? "heads" : "tails";
}

console.log("Coin Toss provably-fair verification\n" + "=".repeat(40));

let allPassed = true;

for (const f of flipsToVerify) {
  console.log(`\n${f.label}`);

  const computedHash = sha256Hex(f.serverSeed);
  const hashOk = computedHash === f.serverSeedHash;
  console.log(`  Seed commitment: ${hashOk ? "✓ MATCH" : "✗ MISMATCH"}`);
  if (!hashOk) {
    console.log(`    expected: ${f.serverSeedHash}`);
    console.log(`    computed: ${computedHash}`);
  }

  const computedResult = resolveFlip(f.serverSeed, f.clientSeed, f.nonce);
  const resultOk = computedResult === f.expectedResult;
  console.log(`  Flip outcome:    ${resultOk ? "✓ MATCH" : "✗ MISMATCH"} (computed: ${computedResult}, expected: ${f.expectedResult})`);

  if (!hashOk || !resultOk) allPassed = false;
}

console.log("\n" + "=".repeat(40));
console.log(allPassed ? "✓ All flips verified — outcomes were not tampered with." : "✗ Something didn't match — see above.");
