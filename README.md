# zunivo-x402-arc

**x402 payments on Arc.** Pay-per-call USDC for AI agents — standard [x402](https://github.com/coinbase/x402) server middleware and an agent client, settled on Arc Testnet.

x402 is the HTTP-native payment standard (Linux Foundation governance; backed by Coinbase, Circle, Visa, Stripe, Google). Its facilitators cover Base, Polygon, Arbitrum, Solana — **not Arc**. This package is that missing piece: it lets an x402-speaking agent pay for an API on Arc, using Arc's USDC-native gas and sub-second finality.

## Server — charge USDC per call in 3 lines

```js
import express from "express";
import { paymentRequired } from "zunivo-x402-arc";

const app = express();
const pay = paymentRequired({ price: "0.05", payTo: "you.agent", zunivoApi: "https://api.zunivo.io", zunivoKey: process.env.ZUNIVO_KEY });
app.get("/v1/data", pay, (req, res) => res.json({ premium: "…" }));
```

Unpaid requests get a standard `402` + `PaymentRequirements` (scheme `exact`, network `arc-testnet`, USDC asset, 6-decimal amount). Paid requests carry `X-PAYMENT` and pass through with an `X-PAYMENT-RESPONSE` receipt.

## Agent — pay automatically

```js
import { createX402Fetch } from "zunivo-x402-arc/client";
const x402fetch = createX402Fetch({ privateKey: process.env.AGENT_PK });
const res = await x402fetch("https://api.example.dev/v1/data"); // discovers price, pays on Arc, retries with proof
const data = await res.json();
```

## Two settlement backends

- **Zunivo orders (default, works today):** payment settles through our verified Arc router `0x4210…Ea55`. `X-PAYMENT` payload is `{ zunivoOrderId }`. No new on-chain code.
- **EIP-3009 facilitator (advanced, gasless):** the fully-standard scheme — the agent signs a `TransferWithAuthorization`, the facilitator submits it to Arc's USDC (`0x3600…0000`, 6 decimals, EIP-3009-capable). See `src/facilitator.mjs`.

## Decimals (read this)

Arc's **native USDC gas** uses **18 decimals**; the **USDC ERC-20 interface** (what x402/EIP-3009 sign against) uses **6 decimals**. This library keeps them strictly separate. Never mix.

## Examples

```
ZUNIVO_API=https://api.zunivo.io ZUNIVO_KEY=zk_… PAY_TO=you.agent npm run example:server
AGENT_PK=0x… npm run example:agent
```

MIT · built on Arc · github.com/zunivo-pay
