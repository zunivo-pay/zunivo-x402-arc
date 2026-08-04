/**
 * Example: a paid API on Arc, x402-standard.
 *
 *   ZUNIVO_API=https://api.zunivo.io ZUNIVO_KEY=zk_... PAY_TO=you.agent \
 *     npm run example:server
 *
 * A standards-compliant x402 client (including our agent example, or any x402 agent
 * once the facilitator path is enabled) can now pay this endpoint on Arc.
 */
import express from "express";
import { paymentRequired } from "../src/index.mjs";

const app = express();

const pay = paymentRequired({
  price: process.env.PRICE ?? "0.05",
  payTo: process.env.PAY_TO ?? "bbb.agent",
  zunivoApi: process.env.ZUNIVO_API ?? "https://api.zunivo.io",
  zunivoKey: process.env.ZUNIVO_KEY ?? "",
  description: "ZUNIVO-CRYPTO-10 live index",
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
