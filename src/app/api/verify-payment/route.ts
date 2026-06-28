import { NextResponse } from "next/server";

const BASESCAN_API = "https://api.etherscan.io/v2/api";
const USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RECIPIENT = "0xCF8A44059652DB5Af8B4CB62938c5DC6916eB082";
const BASESCAN_KEY = process.env.BASESCAN_API_KEY ?? "";

// ERC-20 Transfer(address,address,uint256) topic
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      txHash,
      expectedRecipient,
      expectedMicroUsdc,
      purpose,
      accessoryId,
      fid,
    } = body;

    // ── Basic input validation ────────────────────────────────────────────────
    if (!txHash || typeof txHash !== "string") {
      return NextResponse.json(
        { ok: false, error: "Missing or invalid txHash" },
        { status: 400 }
      );
    }
    if (!expectedRecipient || typeof expectedRecipient !== "string") {
      return NextResponse.json(
        { ok: false, error: "Missing expectedRecipient" },
        { status: 400 }
      );
    }
    if (!expectedMicroUsdc || typeof expectedMicroUsdc !== "number" || expectedMicroUsdc <= 0) {
      return NextResponse.json(
        { ok: false, error: "Missing or invalid expectedMicroUsdc" },
        { status: 400 }
      );
    }
    if (!["checkin", "accessory"].includes(purpose)) {
      return NextResponse.json(
        { ok: false, error: "Invalid purpose" },
        { status: 400 }
      );
    }

    // Safety: recipient must always be our own address — never trust client to
    // pass an arbitrary address and have us approve it.
    if (expectedRecipient.toLowerCase() !== RECIPIENT.toLowerCase()) {
      console.warn("[verify-payment] recipient mismatch — possible tamper attempt", {
        fid,
        expectedRecipient,
        txHash,
      });
      return NextResponse.json(
        { ok: false, error: "Recipient address mismatch" },
        { status: 400 }
      );
    }

    console.log("[verify-payment] checking tx", txHash, "purpose:", purpose, "fid:", fid);

    // ── Poll Etherscan until receipt appears (max 60s, every 3s) ────────────
    // Etherscan can take 5-15s to index a tx after broadcast — one-shot fetch
    // will return null and falsely fail. We poll server-side so the client just
    // sees a spinner until confirmed.
    const receiptUrl = `${BASESCAN_API}?chainid=8453&module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}&apikey=${BASESCAN_KEY}`;

    let receipt: any = null;
    const pollStart = Date.now();
    const POLL_TIMEOUT = 60_000; // 60s max
    const POLL_INTERVAL = 3_000; // check every 3s

    while (Date.now() - pollStart < POLL_TIMEOUT) {
      try {
        const receiptRes = await fetch(receiptUrl, { cache: "no-store" });
        const receiptJson = await receiptRes.json();
        receipt = receiptJson?.result;
        if (receipt && receipt.logs !== undefined) break; // got a receipt with logs
      } catch {
        // network blip — keep polling
      }
      // wait before next poll
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    }

    if (!receipt) {
      console.warn("[verify-payment] receipt still null after 60s for", txHash);
      return NextResponse.json(
        { ok: false, error: "Transaction not confirmed within 60s. If funds were deducted, contact support with your tx hash." },
        { status: 200 }
      );
    }

    // NOTE: We do NOT check receipt.status here — Etherscan API sometimes returns
    // status 0x0 for valid ERC-20 transfers (known API quirk). Instead we go straight
    // to checking the Transfer log — if the log exists and matches, payment happened.

    // ── Verify the USDC Transfer log ─────────────────────────────────────────
    // We look for an ERC-20 Transfer event from the USDC contract where:
    //   topics[1] = sender (any)
    //   topics[2] = recipient (must be our RECIPIENT)
    //   data      = amount in hex (must match expectedMicroUsdc)
    //
    // This is the only reliable on-chain proof that money actually moved.
    const recipientTopic =
      "0x000000000000000000000000" +
      RECIPIENT.replace(/^0x/, "").toLowerCase();

    const expectedAmountHex =
      "0x" + expectedMicroUsdc.toString(16).padStart(64, "0");

    const logs: any[] = receipt.logs ?? [];

    const matchingLog = logs.find(
      (log) =>
        log.address?.toLowerCase() === USDC_CONTRACT.toLowerCase() &&
        log.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC.toLowerCase() &&
        log.topics?.[2]?.toLowerCase() === recipientTopic.toLowerCase() &&
        log.data?.toLowerCase() === expectedAmountHex.toLowerCase()
    );

    if (!matchingLog) {
      console.warn("[verify-payment] no matching USDC Transfer log found", {
        txHash,
        expectedMicroUsdc,
        expectedAmountHex,
        recipientTopic,
        logCount: logs.length,
        logs: logs.map((l) => ({
          address: l.address,
          topic0: l.topics?.[0],
          topic2: l.topics?.[2],
          data: l.data,
        })),
      });
      return NextResponse.json(
        {
          ok: false,
          error:
            "USDC transfer to Grub not found in this transaction. " +
            "Check that you sent USDC on Base to the correct address.",
        },
        { status: 200 }
      );
    }

    // ── All checks passed ─────────────────────────────────────────────────────
    console.log("[verify-payment] ✅ verified", {
      txHash,
      purpose,
      accessoryId: accessoryId ?? null,
      fid: fid ?? null,
      microUsdc: expectedMicroUsdc,
    });

    return NextResponse.json({ ok: true, txHash });
  } catch (err: any) {
    console.error("[verify-payment] unexpected error:", err?.message ?? err);
    return NextResponse.json(
      { ok: false, error: "Internal verification error. Please try again." },
      { status: 500 }
    );
  }
}
