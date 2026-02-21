process.on("unhandledRejection", (err) => console.error("UNHANDLED REJECTION:", err));
process.on("uncaughtException", (err) => console.error("UNCAUGHT EXCEPTION:", err));

const express = require("express");
const WebSocket = require("ws");
const app = express();

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_WS = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const TRACKED_TOKEN_MINT = "HACLKPh6WQ79gP9NuufSs9VkDUjVsk5wCdbBCjTLpump";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const MIN_SOL = 0.001;

let recentBuys = [];

function detectBuysFromTokenTransfers(transfers) {
  const list = Array.isArray(transfers) ? transfers : [];
  const deltaByWallet = Object.create(null);
  for (const t of list) {
    const amount = Number(t.tokenAmount ?? 0);
    if (amount <= 0) continue;
    const mint = t.mint;
    const to = t.toUserAccount;
    const from = t.fromUserAccount;
    if (to) {
      if (!deltaByWallet[to]) deltaByWallet[to] = Object.create(null);
      deltaByWallet[to][mint] = (deltaByWallet[to][mint] || 0) + amount;
    }
    if (from) {
      if (!deltaByWallet[from]) deltaByWallet[from] = Object.create(null);
      deltaByWallet[from][mint] = (deltaByWallet[from][mint] || 0) - amount;
    }
  }
  const buyers = [];
  for (const wallet of Object.keys(deltaByWallet)) {
    const deltaTracked = deltaByWallet[wallet][TRACKED_TOKEN_MINT] || 0;
    const deltaWSOL = deltaByWallet[wallet][WSOL_MINT] || 0;
    if (deltaTracked > 0 && deltaWSOL < 0) {
      const solSpent = Math.abs(deltaWSOL);
      if (solSpent >= MIN_SOL) buyers.push({ wallet, solSpent });
    }
  }
  return buyers;
}

function detectBuyFromTx(tx) {
  if (tx?.transactionError) return null;
  const swap = tx?.events?.swap;
  if (!swap) return null;
  const hasTrackedOut = swap.tokenOutputs?.some((o) => o?.mint === TRACKED_TOKEN_MINT);
  if (!hasTrackedOut) return null;
  let solSpent = 0;
  if (swap.nativeInput && swap.nativeInput > 0) {
    solSpent = Number(swap.nativeInput);
  } else {
    const wsolInput = swap.tokenInputs?.find((i) => i?.mint === WSOL_MINT);
    if (wsolInput) solSpent = Number(wsolInput.tokenAmount || 0);
  }
  if (solSpent <= 0 || !swap.userAccount) return null;
  return { wallet: swap.userAccount, solSpent, sig: tx.signature };
}

app.use(express.json());
app.use(express.static(__dirname));

app.get("/status", (req, res) => res.json({ ok: true }));
app.get("/buys", (req, res) => res.json(recentBuys));

app.post("/helius", (req, res) => {
  try {
    const txs = Array.isArray(req.body) ? req.body : [req.body];
    for (const tx of txs) {
      const buy = detectBuyFromTx(tx);
      if (!buy) continue;
      recentBuys.unshift({ wallet: buy.wallet, sol: buy.solSpent, time: Date.now() });
      if (recentBuys.length > 50) recentBuys.pop();
      console.log("BUY:", buy.wallet, buy.solSpent);
    }
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: true });
  }
});

function startHeliusWebSocket() {
  try {
    const ws = new WebSocket(HELIUS_WS);
    ws.on("open", () => {
      console.log("Helius WebSocket connected");
      try {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "logsSubscribe",
            params: [
              { mentions: ["HACLKPh6WQ79gP9NuufSs9VkDUjVsk5wCdbBCjTLpump"] },
              { commitment: "processed" }
            ]
          })
        );
      } catch (err) {}
    });
    ws.on("error", () => {});
    ws.on("message", async (msg) => {
      try {
        const data = JSON.parse(msg.toString() || "{}");
        const signature = data?.params?.result?.value?.signature;
        if (!signature) return;

        console.log("WS SIG:", signature);

        const response = await fetch(
          `https://api.helius.xyz/v0/transactions/?api-key=${process.env.HELIUS_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ transactions: [signature] })
          }
        );

        if (response.status === 429) {
          console.log("Enhanced API rate limited");
          return;
        }

        const txs = await response.json();
        if (!txs || !txs[0]) return;

        const tx = Array.isArray(txs) ? txs[0] : txs;
        const transfers = tx?.tokenTransfers || [];
        const buyers = detectBuysFromTokenTransfers(transfers);

        for (const { wallet, solSpent } of buyers) {
          recentBuys.unshift({ wallet, sol: solSpent, time: Date.now() });
          if (recentBuys.length > 50) recentBuys.pop();
          console.log("WS BUY:", wallet, solSpent);
        }
      } catch (e) {}
    });
    ws.on("close", () => setTimeout(startHeliusWebSocket, 3000));
  } catch (err) {
    console.error("startHeliusWebSocket:", err?.message || err);
  }
}

const PORT = 3000;
app.listen(PORT, () => {
  console.log("Server listening on port", PORT);
  startHeliusWebSocket();
});
