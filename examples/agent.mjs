/**
 * Example: an autonomous agent paying an x402 endpoint on Arc.
 *
 *   AGENT_PK=0x... API_URL=http://localhost:9090/v1/index/crypto npm run example:agent
 *
 * The whole x402 dance — discover price, pay on Arc, retry with proof — is one call.
 */
import { createX402Fetch } from "../src/client.mjs";

const API_URL = process.env.API_URL ?? "http://localhost:9090/v1/index/crypto";
const x402fetch = createX402Fetch({
  privateKey: process.env.AGENT_PK,
  maxPrice: process.env.MAX_PRICE ?? "1",
  onEvent: (e) => {
    if (e.type === "quote")  console.log(`  ◇ 402 — price ${e.price} USDC on ${e.network} → ${e.payTo}`);
    if (e.type === "paying") console.log(`  ◇ paying ${e.price} USDC on Arc from my own wallet…`);
    if (e.type === "paid")   console.log(`  ◇ paid  tx ${e.txHash}`);
    if (e.type === "served") console.log(`  ◇ served · receipt ${e.receipt?.txHash ?? ""}`);
  },
});

console.log(`\nagent → ${API_URL}`);
const res = await x402fetch(API_URL);
const data = await res.json();
console.log("\nPAID DATA:", JSON.stringify(data, null, 2));
console.log("\nNo card. No human. One function call. That's x402 on Arc.\n");
