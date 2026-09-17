# zunivo-x402-arc

**x402 payments on Arc.** Pay-per-call USDC for AI agents — standard [x402](https://github.com/coinbase/x402) server middleware and an agent client, settled on **Arc mainnet** (with the testnet sandbox one flag away).

x402 is the HTTP-native payment standard (Linux Foundation governance; backed by Coinbase, Circle, Visa, Stripe, Google). Its facilitators cover Base, Polygon, Arbitrum, Solana — **not Arc**. This package is that missing piece: it lets an x402-speaking agent pay for an API on Arc, using Arc's USDC-native gas and sub-second finality.

## 1.0.0 — mainnet is the default

| | `network: "arc"` (default) | `network: "arc-testnet"` |
|---|---|---|
| Chain | Arc mainnet, chainId **5042** (`eip155:5042`) | Arc testnet, chainId 5042002 (`eip155:5042002`) |
| Money | **real USDC** | free faucet USDC |
| Router | `0xAa8c…7119` (v1.3, [verified](https://arc.etherscan.io/address/0xAa8c293495446d04a51A32e2e4557EDE3BfC7119)) | `0x4210…Ea55` |
| Zunivo API | `https://api.zunivo.io` | `https://testnet-api.zunivo.io` |

Upgrading from 0.x: the default network flipped from testnet to mainnet. Pass `network: "arc-testnet"` explicitly (or set `ZUNIVO_NETWORK=arc-testnet` process-wide) to keep sandbox behaviour. Nothing else changed.

## Server — charge USDC per call in 3 lines

```js
import express from "express";
import { paymentRequired } from "zunivo-x402-arc";

const app = express();
const pay = paymentRequired({
  price: "0.05", payTo: "you.agent",
  zunivoApi: "https://api.zunivo.io", zunivoKey: process.env.ZUNIVO_KEY,
  consumedStore: myRedisOrDbStore,          // required on mainnet (durable replay protection)
});
app.get("/v1/data", pay, (req, res) => res.json({ premium: "…" }));
```

Unpaid requests get a standard `402` + `PaymentRequirements` (scheme `exact`, USDC asset, 6-decimal amount) listed under **both** the legacy network name (`arc`) and the CAIP-2 id (`eip155:5042`), so standards-first catalogs such as Circle's Discovery API index it. Paid requests carry `X-PAYMENT` and pass through with an `X-PAYMENT-RESPONSE` receipt.

On mainnet the middleware **refuses to start without a durable `consumedStore`** (`{ reserve(key) }` or `{ has, add }`) — the in-memory default would let a real payment be replayed across restarts.

## Agent — pay automatically

```js
import { createX402Fetch } from "zunivo-x402-arc/client";
const x402fetch = createX402Fetch({
  privateKey: process.env.AGENT_PK,
  maxPrice: "0.10",                  // hard cap per call, checked in integer base units
  expectRecipient: "0xabc…",         // pin the payee — strongly recommended on mainnet
});
const res = await x402fetch("https://api.example.dev/v1/data"); // discovers price, pays on Arc, retries with proof
const data = await res.json();
```

Safety rails that always run: strict amount parsing (no NaN / negative / >6 dp), `maxPrice` compared as BigInt, network mismatch → refuse, recipient pinning, and a loud warning if you pay on mainnet without `expectRecipient`.

## Discover an agent by name

```js
import { connectAgent } from "zunivo-x402-arc";
const data = await connectAgent("data.agent", { privateKey: process.env.AGENT_PK });
const res  = await data.fetch("/v1/index/crypto");   // 402 handled, USDC paid, payee pinned to data.agent
```

Reads the `.agent` name's on-chain records (ZunivoNames + ZunivoAgentRecords) on the selected network.

## Two settlement backends

- **Zunivo orders (default, live on mainnet):** payment settles through the verified ArcPayRouter; `X-PAYMENT` payload is `{ zunivoOrderId, txHash }`.
- **EIP-3009 facilitator (advanced, gasless):** the fully-standard scheme — the agent signs a `TransferWithAuthorization`, the facilitator submits it to Arc's USDC ERC-20 interface (`0x3600…0000`, 6 decimals). EIP-712 `name`/`version` are read on-chain. See `src/facilitator.mjs`.

## Decimals (read this)

Arc's **native USDC gas** uses **18 decimals**; the **USDC ERC-20 interface** (what x402/EIP-3009 sign against) uses **6 decimals**. This library keeps them strictly separate. Never mix.

## Env overrides

| Var | Effect |
|---|---|
| `ZUNIVO_NETWORK` | process-wide default network (`arc` \| `arc-testnet`) |
| `ZUNIVO_MAINNET_RPC_URL` | use your own / dedicated Arc mainnet RPC (recommended in production — the public gateway rate-limits) |
| `ZUNIVO_RPC_URL`, `ZUNIVO_NAMES_ADDRESS`, `ZUNIVO_RECORDS_ADDRESS` | discovery overrides |

## Examples & tests

```
npm test
ZUNIVO_API=https://api.zunivo.io ZUNIVO_KEY=zk_… PAY_TO=you.agent npm run example:server
AGENT_PK=0x… npm run example:agent                       # mainnet, real USDC
NETWORK=arc-testnet AGENT_PK=0x… npm run example:agent   # sandbox
```

MIT · built on Arc · github.com/zunivo-pay
