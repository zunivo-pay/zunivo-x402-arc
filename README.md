# zunivo-x402-arc

x402 payments on Arc. Express middleware that answers 402 with a USDC price, and a client that pays it and retries. Settles on Arc mainnet by default; testnet is one option away.

x402 is the HTTP 402 payment standard (Linux Foundation, used by Coinbase and Circle). Its public facilitators don't cover Arc. This package does.

## Networks

`network: "arc"` is the default since 1.0.0 and means Arc mainnet, chainId 5042, real USDC, router `0xAa8c…7119`, API `https://api.zunivo.io`.

`network: "arc-testnet"` is the free sandbox: chainId 5042002, router `0x4210…Ea55`, API `https://testnet-api.zunivo.io`.

The CAIP-2 forms `eip155:5042` and `eip155:5042002` are accepted too. `ZUNIVO_NETWORK=arc-testnet` sets the default for the whole process.

If you're upgrading from 0.x: the default flipped from testnet to mainnet. Pass `network: "arc-testnet"` to keep the old behaviour.

## Server

```js
import express from "express";
import { paymentRequired } from "zunivo-x402-arc";

const app = express();
const pay = paymentRequired({
  price: "0.05", payTo: "you.agent",
  zunivoApi: "https://api.zunivo.io", zunivoKey: process.env.ZUNIVO_KEY,
  consumedStore: myRedisOrDbStore,   // required on mainnet
});
app.get("/v1/data", pay, (req, res) => res.json({ premium: "…" }));
```

An unpaid request gets a 402 with PaymentRequirements (scheme `exact`, USDC, 6-decimal amount), listed under both `arc` and `eip155:5042` so standards-based catalogs find it. A paid request carries `X-PAYMENT` and goes through; the response gets an `X-PAYMENT-RESPONSE` receipt.

On mainnet the middleware refuses to start without a durable `consumedStore` (an object with `reserve(key)`, or `has` + `add`). The in-memory default would let a payment be replayed after a restart.

## Agent

```js
import { createX402Fetch } from "zunivo-x402-arc/client";
const x402fetch = createX402Fetch({
  privateKey: process.env.AGENT_PK,
  maxPrice: "0.10",            // per-call cap, compared as integer base units
  expectRecipient: "0xabc…",   // refuse to pay anyone else
});
const res = await x402fetch("https://api.example.dev/v1/data");
const data = await res.json();
```

Amounts are parsed strictly, maxPrice is compared as BigInt, a network mismatch is refused, and paying on mainnet without `expectRecipient` logs a warning.

## By name

```js
import { connectAgent } from "zunivo-x402-arc";
const data = await connectAgent("data.agent", { privateKey: process.env.AGENT_PK });
const res  = await data.fetch("/v1/index/crypto");
```

Reads the name's on-chain records (endpoint, x402 manifest) and pins the payee to the name's address.

## Settlement paths

Default: a Zunivo order paid through the verified ArcPayRouter. `X-PAYMENT` is `{ zunivoOrderId, txHash }`.

Alternative: EIP-3009. The agent signs a `TransferWithAuthorization` and a facilitator submits it to USDC (`0x3600…0000`, 6 decimals). See `src/facilitator.mjs`. Check the selectors on Arc before using it for real money.

## Decimals

Native USDC gas on Arc has 18 decimals. The USDC ERC-20 interface, which x402 and EIP-3009 use, has 6. Don't mix them. The library keeps the two paths separate.

## Env

`ZUNIVO_NETWORK` default network. `ZUNIVO_MAINNET_RPC_URL` your own RPC (the public one rate-limits). `ZUNIVO_RPC_URL`, `ZUNIVO_NAMES_ADDRESS`, `ZUNIVO_RECORDS_ADDRESS` override discovery.

## Run

```
npm test
ZUNIVO_API=https://api.zunivo.io ZUNIVO_KEY=zk_… PAY_TO=you.agent npm run example:server
AGENT_PK=0x… npm run example:agent
NETWORK=arc-testnet AGENT_PK=0x… npm run example:agent
```

MIT. github.com/zunivo-pay
