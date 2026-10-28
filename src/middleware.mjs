/**
 * paymentRequired(): x402 paywall middleware for Express.
 *
 *   1. no payment     -> 402 with PaymentRequirements (body + PAYMENT-REQUIRED header)
 *   2. client retries with an X-PAYMENT header (base64 JSON)
 *   3. we verify the payment settled on Arc, serve the route, add X-PAYMENT-RESPONSE
 *
 * Settlement is pluggable via `verify`. Default is a Zunivo order paid through
 * the ArcPayRouter and confirmed through the Zunivo API. facilitator.mjs has an
 * EIP-3009 variant for gasless signature payments.
 *
 *   import { paymentRequired } from "zunivo-x402-arc";
 *   const pay = paymentRequired({ price: "0.05", payTo: "you.agent", zunivoApi, zunivoKey });
 *   app.get("/v1/data", pay, handler);
 */
import { resolveNetwork, isMainnet, DEFAULT_NETWORK, toUsdcBaseUnits, encodeHeader, decodeHeader } from "./arc.mjs";

/**
 * Default replay store. In-memory, so single process and gone on restart.
 * For production pass `consumedStore`: anything with async reserve(key), or has/add.
 * A settled payment must only ever be consumed once.
 */
function memoryStore() {
  const seen = new Set();
  return {
    // check-and-reserve in one step. true if the key was new, false if already used.
    async reserve(k) { if (seen.has(k)) return false; seen.add(k); return true; },
    // Back-compat shims for stores that only implement has/add.
    async has(k) { return seen.has(k); },
    async add(k) { seen.add(k); },
  };
}

// Prefer the store's own reserve(). has()+add() is a fallback and is only race-free in a single process.
async function reserveOnce(store, key) {
  if (typeof store.reserve === "function") return store.reserve(key);
  if (await store.has(key)) return false;
  await store.add(key);
  return true;
}

export function paymentRequired(opts) {
  const {
    price,
    payTo,
    zunivoApi = "https://api.zunivo.io",
    zunivoKey = "",
    description = "",
    verify,               // optional custom verifier(paymentPayload, requirements) -> { settled, txHash }
    resource,             // optional canonical resource URL
    consumedStore = memoryStore(),   // pluggable, so replay survives restarts / spans instances
  } = opts;

  const {
    network = DEFAULT_NETWORK, // "arc" (MAINNET, default since 1.0.0) or "arc-testnet"
  } = opts;
  const NET = resolveNetwork(network);   // throws on unknown / half-configured mainnet

  // Reject a bad price at construction rather than at settlement time.
  const priceNum = Number(price);
  if (!Number.isFinite(priceNum) || priceNum < 0) {
    throw new Error(`paymentRequired: invalid price "${price}" (must be a non-negative number)`);
  }

  // On mainnet an in-memory replay store would let a real payment be reused after a restart
  // or across instances, so require a durable one.
  if (isMainnet(NET) && !opts.consumedStore) {
    throw new Error(
      "mainnet requires a durable shared consumedStore (e.g. Redis). The default in-memory " +
      "store is single-process and would allow real payments to be replayed across instances.",
    );
  }

  const settle = verify ?? zunivoVerify({ zunivoApi, zunivoKey });

  return async function x402(req, res, next) {
    const payHeader = req.header("X-PAYMENT") || req.header("PAYMENT-SIGNATURE");
    const resourceUrl = resource || `${req.protocol}://${req.get("host")}${req.originalUrl}`;

    // Same offer listed twice: once under the legacy network name ("arc" / "arc-testnet"),
    // once under the CAIP-2 id ("eip155:5042" / "eip155:5042002") that catalogs like
    // Circle's Discovery API index by.
    const baseAccept = {
      scheme: "exact",
      maxAmountRequired: toUsdcBaseUnits(price),   // 6-decimal base units
      resource: resourceUrl,
      description: description || `Pay ${price} USDC to access ${req.path}`,
      mimeType: "application/json",
      payTo,
      maxTimeoutSeconds: 120,
      asset: NET.usdc,
      extra: { name: "USDC", decimals: NET.usdcDecimals, chainId: NET.chainId },
    };
    const requirements = {
      x402Version: 1,
      accepts: NET.caip2
        ? [
            { ...baseAccept, network: NET.x402Network, extra: { ...baseAccept.extra } },
            { ...baseAccept, network: NET.caip2, extra: { ...baseAccept.extra } },
          ]
        : [{ ...baseAccept, network: NET.x402Network, extra: { ...baseAccept.extra } }],
    };

    // No payment attached → 402 with requirements (both body and header, per spec).
    if (!payHeader) {
      // For the Zunivo backend we also mint an order so a browser/agent can pay immediately.
      let order = null;
      try {
        order = await settle.quote?.(price, payTo, `${description || "x402"} · ${req.method} ${req.path}`);
      } catch { /* quote is best-effort; requirements alone are spec-sufficient */ }
      if (order) {
        // same order backs every accepts entry (they are one offer in two namings)
        for (const a of requirements.accepts) {
          a.extra.zunivoOrderId = order.id;
          a.extra.payUrl = order.payUrl;
          // resolved on-chain merchant address (name → address happens server-side);
          // the client needs this 20-byte address to settle, not the human name.
          if (order.to) a.extra.payToAddress = order.to;
        }
      }
      res.setHeader("PAYMENT-REQUIRED", encodeHeader(requirements));
      return res.status(402).json(requirements);
    }

    // Payment attached → decode and verify.
    const payload = decodeHeader(payHeader);
    if (!payload) return res.status(402).json({ ...requirements, error: "malformed X-PAYMENT header" });

    // Verify before touching the replay store; the idempotency key comes from the client.
    let result;
    try {
      result = await settle.verify(payload, requirements.accepts[0]);
    } catch (e) {
      return res.status(402).json({ ...requirements, error: `verification failed: ${e.message}` });
    }
    if (!result?.settled) {
      return res.status(402).json({
        ...requirements,
        error: "payment not settled", status: result?.status, reason: result?.reason, retryInSeconds: 8,
      });
    }

    // Replay key is built from settled facts (resource + order + tx), scoped to this resource,
    // so one payment unlocks one resource once.
    const orderId = payload?.zunivoOrderId || payload?.payload?.authorization?.nonce || "";
    const replayKey = `${resourceUrl}::${orderId}::${result.txHash ?? ""}`;
    // Atomic reserve so two concurrent requests with the same payment can't both be served.
    const fresh = await reserveOnce(consumedStore, replayKey);
    if (!fresh) {
      return res.status(402).json({ ...requirements, error: "payment already consumed, pay again for another call" });
    }
    res.setHeader(
      "X-PAYMENT-RESPONSE",
      encodeHeader({ success: true, txHash: result.txHash, network: NET.x402Network }),
    );
    next();
  };
}

/**
 * Default settlement backend: Zunivo orders paid through the ArcPayRouter.
 * quote() creates an order, verify() checks it settled.
 * X-PAYMENT payload is { zunivoOrderId }.
 */
function zunivoVerify({ zunivoApi, zunivoKey }) {
  return {
    async quote(price, payTo, memo) {
      const r = await fetch(`${zunivoApi}/v1/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": zunivoKey },
        body: JSON.stringify({ to: payTo, amount: price, memo }),
      });
      if (!r.ok) throw new Error("zunivo order create failed");
      return r.json();
    },
    async verify(payload, accept) {
      const orderId = payload?.zunivoOrderId;
      if (!orderId) throw new Error("payload missing zunivoOrderId (Zunivo backend expects { zunivoOrderId })");
      const r = await fetch(`${zunivoApi}/v1/orders/${orderId}`, { headers: { "X-Api-Key": zunivoKey } });
      if (!r.ok) throw new Error("unknown order");
      const order = await r.json();

      // A paid order is not enough on its own. It has to be paid to this resource's payTo
      // for at least the required amount, or a cheap order could unlock an expensive route.
      const paid = order.status === "paid";
      if (paid && accept) {
        const requiredBase = BigInt(accept.maxAmountRequired);                 // 6-dec base units
        const orderBase = BigInt(toUsdcBaseUnits(String(order.amount ?? "0")));
        if (orderBase < requiredBase) {
          return { settled: false, status: "underpaid", reason: `order paid ${order.amount} < required` };
        }
        const wantTo = (accept.extra?.payToAddress || accept.payTo || "").toLowerCase();
        const gotTo = String(order.to ?? "").toLowerCase();
        // compare resolved recipient when we have it on both sides
        if (wantTo && gotTo && wantTo.startsWith("0x") && gotTo.startsWith("0x") && wantTo !== gotTo) {
          return { settled: false, status: "wrong-recipient", reason: "order paid to a different recipient" };
        }
      }

      return {
        settled: paid,
        status: order.status,
        amount: order.amount,
        to: order.to,
        txHash: order.payments?.[0]?.txHash ?? null,
      };
    },
  };
}
