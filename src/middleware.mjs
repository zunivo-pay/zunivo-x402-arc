/**
 * paymentRequired() — x402-standard paywall middleware for Arc, Express-compatible.
 *
 * Speaks the x402 wire protocol (the one ~69k agents already use):
 *   1. No payment  → 402 with a `PaymentRequirements` object (body + PAYMENT-REQUIRED header)
 *   2. Client attaches an `X-PAYMENT` header (base64 JSON payment payload) and retries
 *   3. Middleware verifies the payment settled on Arc, then serves the resource and
 *      returns an `X-PAYMENT-RESPONSE` header (base64 JSON settlement receipt)
 *
 * Settlement backend is pluggable via `verify`:
 *   - default: Zunivo settlement (order created up-front, paid on Arc via our verified
 *     router, confirmed through the Zunivo API) — works today, no new onchain code.
 *   - advanced: an EIP-3009 facilitator (see facilitator.mjs) for gasless signature pay.
 *
 * Three lines to protect any route:
 *   import { paymentRequired } from "@zunivo/x402-arc";
 *   const pay = paymentRequired({ price: "0.05", payTo: "you.zunivo", zunivoApi, zunivoKey });
 *   app.get("/v1/data", pay, handler);
 */
import { resolveNetwork, toUsdcBaseUnits, encodeHeader, decodeHeader } from "./arc.mjs";

/**
 * Default replay store: in-memory Map. NOTE: single-process and cleared on restart.
 * For production (multi-instance or restart-durable) pass `consumedStore` — any object
 * with async has(key)/add(key). A settled order must be consumable exactly once, ever.
 */
function memoryStore() {
  const seen = new Set();
  return {
    // Atomic check-and-reserve: returns true if this key was NEW (now reserved),
    // false if already consumed. Synchronous set ops = no TOCTOU gap. (F-2)
    async reserve(k) { if (seen.has(k)) return false; seen.add(k); return true; },
    // Back-compat shims for stores that only implement has/add.
    async has(k) { return seen.has(k); },
    async add(k) { seen.add(k); },
  };
}

// Reserve a key atomically across any store shape: prefer a native atomic reserve(),
// fall back to has()+add() (non-atomic — only safe single-process). (F-2)
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
    consumedStore = memoryStore(),   // V-1: pluggable, so replay survives restarts / spans instances
  } = opts;

  const {
    network = "arc-testnet",   // MN-1: "arc" (mainnet) or "arc-testnet"
  } = opts;
  const NET = resolveNetwork(network);   // throws on unknown / half-configured mainnet

  // Validate price up front — a malformed/negative price must fail loud, not settle weird.
  const priceNum = Number(price);
  if (!Number.isFinite(priceNum) || priceNum < 0) {
    throw new Error(`paymentRequired: invalid price "${price}" (must be a non-negative number)`);
  }

  // MN-4: the in-memory replay store is single-process and clears on restart. On mainnet that
  // means a real payment can be double-spent across instances/restarts. Refuse to boot on
  // mainnet unless the caller supplies a durable, shared consumedStore (Redis/DB).
  if (network === "arc" && !opts.consumedStore) {
    throw new Error(
      "mainnet requires a durable shared consumedStore (e.g. Redis) — the default in-memory " +
      "store is single-process and would allow real payments to be replayed across instances.",
    );
  }

  const settle = verify ?? zunivoVerify({ zunivoApi, zunivoKey });

  return async function x402(req, res, next) {
    const payHeader = req.header("X-PAYMENT") || req.header("PAYMENT-SIGNATURE");
    const resourceUrl = resource || `${req.protocol}://${req.get("host")}${req.originalUrl}`;

    // Build the standard PaymentRequirements for this resource.
    const requirements = {
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: NET.x402Network,
          maxAmountRequired: toUsdcBaseUnits(price),   // 6-decimal base units
          resource: resourceUrl,
          description: description || `Pay ${price} USDC to access ${req.path}`,
          mimeType: "application/json",
          payTo,
          maxTimeoutSeconds: 120,
          asset: NET.usdc,
          extra: { name: "USDC", decimals: NET.usdcDecimals, chainId: NET.chainId },
        },
      ],
    };

    // No payment attached → 402 with requirements (both body and header, per spec).
    if (!payHeader) {
      // For the Zunivo backend we also mint an order so a browser/agent can pay immediately.
      let order = null;
      try {
        order = await settle.quote?.(price, payTo, `${description || "x402"} · ${req.method} ${req.path}`);
      } catch { /* quote is best-effort; requirements alone are spec-sufficient */ }
      if (order) {
        requirements.accepts[0].extra.zunivoOrderId = order.id;
        requirements.accepts[0].extra.payUrl = order.payUrl;
        // resolved on-chain merchant address (name → address happens server-side);
        // the client needs this 20-byte address to settle, not the human name.
        if (order.to) requirements.accepts[0].extra.payToAddress = order.to;
      }
      res.setHeader("PAYMENT-REQUIRED", encodeHeader(requirements));
      return res.status(402).json(requirements);
    }

    // Payment attached → decode and verify.
    const payload = decodeHeader(payHeader);
    if (!payload) return res.status(402).json({ ...requirements, error: "malformed X-PAYMENT header" });

    // Verify FIRST (V-4: never trust a client-forgeable idem key before verification).
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

    // V-1: replay key is built from SETTLED facts (resource + order + on-chain tx), not raw input,
    // and scoped to THIS resource so one payment unlocks one resource once.
    const orderId = payload?.zunivoOrderId || payload?.payload?.authorization?.nonce || "";
    const replayKey = `${resourceUrl}::${orderId}::${result.txHash ?? ""}`;
    // F-2: atomic reserve closes the check-then-add race — two concurrent requests
    // carrying the same settled payment can no longer both be served.
    const fresh = await reserveOnce(consumedStore, replayKey);
    if (!fresh) {
      return res.status(402).json({ ...requirements, error: "payment already consumed — pay again for another call" });
    }
    res.setHeader(
      "X-PAYMENT-RESPONSE",
      encodeHeader({ success: true, txHash: result.txHash, network: NET.x402Network }),
    );
    next();
  };
}

/**
 * Default settlement backend: Zunivo orders + our verified Arc router.
 * `quote()` mints an order; `verify()` confirms it settled.
 * The X-PAYMENT payload for this backend is simply { zunivoOrderId } (the agent pays
 * the order on Arc, then attaches its id). This is the "standard face, Zunivo settlement"
 * path that works today with zero new onchain code.
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

      // V-2: a paid order is NOT a blank pass. It must be the RIGHT order —
      // paid to THIS resource's payTo, for AT LEAST the required amount.
      // Otherwise a cheap or someone-else's order could unlock an expensive endpoint.
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
