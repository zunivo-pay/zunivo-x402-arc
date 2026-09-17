/**
 * Example: a paid API on Arc, x402-standard.
 *
 *   ZUNIVO_API=https://api.zunivo.io ZUNIVO_KEY=zk_... PAY_TO=you.agent \
 *     npm run example:server
 *   (Arc MAINNET by default. NETWORK=arc-testnet ZUNIVO_API=https://testnet-api.zunivo.io for the sandbox.)
 *
 * A standards-compliant x402 client (including our agent example, or any x402 agent
 * once the facilitator path is enabled) can now pay this endpoint on Arc.
 */
import express from "express";
import fs from "node:fs";
import { paymentRequired } from "../src/index.mjs";

/** Minimal durable replay store for the example (JSON file). Use Redis/DB in production. */
function fileStore(path) {
  const load = () => { try { return new Set(JSON.parse(fs.readFileSync(path, "utf8"))); } catch { return new Set(); } };
  const set = load();
  const save = () => fs.writeFileSync(path, JSON.stringify([...set]));
  return {
    // atomic check-and-reserve (sync set ops → no TOCTOU gap within one process)
    reserve: async (k) => { if (set.has(k)) return false; set.add(k); save(); return true; },
    has: async (k) => set.has(k),
    add: async (k) => { set.add(k); save(); },
  };
}

const app = express();

const pay = paymentRequired({
  price: process.env.PRICE ?? "0.05",
  payTo: process.env.PAY_TO ?? "bbb.agent",
  zunivoApi: process.env.ZUNIVO_API ?? "https://api.zunivo.io",
  zunivoKey: process.env.ZUNIVO_KEY ?? "",
  network: process.env.NETWORK ?? "arc",
  description: "ZUNIVO-CRYPTO-10 live index",
  // mainnet requires a durable replay store; the example uses the in-memory one only on testnet
  ...(process.env.NETWORK === "arc-testnet" ? {} : { consumedStore: fileStore(".x402-consumed.json") }),
});

app.get("/v1/index/crypto", pay, (_req, res) => {
  res.json({
    index: "ZUNIVO-CRYPTO-10",
    value: (41200 + Math.random() * 900).toFixed(2),
    asOf: new Date().toISOString(),
    note: "paid for on-chain via x402 on Arc",
  });
});

const PORT = process.env.PORT ?? 9090;
app.listen(PORT, () =>
  console.log(`[x402 server] ${process.env.PRICE ?? "0.05"} USDC/call · x402 on Arc · http://localhost:${PORT}/v1/index/crypto`),
);
