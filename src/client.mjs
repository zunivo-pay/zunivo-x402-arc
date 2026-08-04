/**
 * x402 client for agents on Arc.
 *
 * Wrap any endpoint call so your agent pays automatically when it hits a 402 —
 * discover price, pay on Arc, retry with proof, get data. One function.
 *
 *   import { createX402Fetch } from "@zunivo/x402-arc/client";
 *   const x402fetch = createX402Fetch({ privateKey: process.env.AGENT_PK });
 *   const res = await x402fetch("https://api.example.dev/v1/data");
 *   const data = await res.json();   // paid for, on-chain, no human
 *
 * Backend parity with the middleware: this pays a Zunivo order on our verified
 * Arc router, then retries with { zunivoOrderId } as the X-PAYMENT payload. An
 * EIP-3009 signature mode is provided separately for the gasless facilitator path.
 */
import {
  createWalletClient, createPublicClient, http, parseEther,
  keccak256, toHex, parseAbi, defineChain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolveNetwork, encodeHeader, decodeHeader, fromUsdcBaseUnits, toUsdcBaseUnits, cmpBaseUnits } from "./arc.mjs";

const ROUTER_ABI = parseAbi(["function pay(bytes32 orderId, address merchant) payable"]);

export function createX402Fetch({
  privateKey, maxPrice, expectRecipient,
  network = "arc-testnet",           // MN-1: choose "arc" (mainnet) or "arc-testnet" explicitly
  requireExpectRecipient = false,    // MN-2: when true, refuse to pay unless expectRecipient is set
  onEvent = () => {}, settleTimeoutMs = 120_000,
}) {
  if (!privateKey) throw new Error("createX402Fetch: privateKey required");
  const NET = resolveNetwork(network);              // throws on unknown / half-configured mainnet
  const ROUTER = NET.router;
  // MN-2: on mainnet, blindly trusting the server's payTo address is a real-money risk.
  // Require the caller to pin the expected recipient (or explicitly opt out on testnet).
  if (network === "arc" && !expectRecipient && !requireExpectRecipient) {
    // default-safe on mainnet: warn loudly via event; callers should set expectRecipient.
    onEvent({ type: "warn", message: "mainnet without expectRecipient — paying whatever address the server quotes" });
  }
  if (requireExpectRecipient && !expectRecipient) {
    throw new Error("requireExpectRecipient is set but expectRecipient was not provided");
  }
  const arc = defineChain({
    id: NET.chainId, name: NET.name,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [NET.rpcUrl] } },
  });
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain: arc, transport: http() });
  const pub = createPublicClient({ chain: arc, transport: http() });

  return async function x402fetch(url, init = {}) {
    // 1. try unpaid
    let res = await fetch(url, init);
    if (res.status !== 402) return res;

    // 2. read requirements (prefer header, fall back to body)
    const headerReq = decodeHeader(res.headers.get("PAYMENT-REQUIRED") || "");
    const bodyReq = await res.clone().json().catch(() => null);
    const req = headerReq || bodyReq;
    const accept = req?.accepts?.[0];
    if (!accept) throw new Error("402 without usable PaymentRequirements");

    // V-10/V-11: never trust the server amount blindly. fromUsdcBaseUnits throws on any
    // malformed/negative/NaN value, and the maxPrice check is done in integer base units
    // (BigInt) so no float rounding or NaN can slip a payment past the wallet's fuse.
    let requiredBase;
    try {
      requiredBase = BigInt(accept.maxAmountRequired);
      if (requiredBase < 0n) throw new Error("negative");
    } catch {
      throw new Error(`server sent an invalid amount: ${JSON.stringify(accept.maxAmountRequired)}`);
    }
    // MN-1: never settle on a network mismatch — a server quoting a different network than
    // the agent is configured for is a red flag (and a way to trick a mainnet agent onto a
    // worthless chain or vice-versa).
    if (accept.network && accept.network !== NET.x402Network) {
      throw new Error(`network mismatch: server quoted "${accept.network}" but agent is on "${NET.x402Network}"`);
    }
    const human = fromUsdcBaseUnits(requiredBase.toString());
    onEvent({ type: "quote", price: human, network: accept.network, payTo: accept.payTo });
    if (maxPrice != null) {
      const capBase = BigInt(toUsdcBaseUnits(String(maxPrice)));   // strict-parses maxPrice too
      if (cmpBaseUnits(requiredBase, capBase) > 0) {
        throw new Error(`price ${human} USDC exceeds maxPrice ${maxPrice}`);
      }
    }

    // 3. pay on Arc. Zunivo backend: pay the minted order via our verified router.
    const orderId = accept.extra?.zunivoOrderId;
    if (!orderId) throw new Error("Zunivo backend expected extra.zunivoOrderId in requirements");
    // Settle to the resolved 20-byte address (a .agent name is resolved server-side and
    // returned as extra.payToAddress). Fall back to payTo only if it is already an address.
    const merchant = accept.extra?.payToAddress || accept.payTo;
    if (!/^0x[0-9a-fA-F]{40}$/.test(merchant)) {
      throw new Error(`cannot settle: merchant address unresolved (got "${merchant}"). The paid endpoint must expose extra.payToAddress.`);
    }
    // V-12: optional recipient pinning — if the agent knows who it intends to pay,
    // refuse a server that swaps in a different payee address.
    if (expectRecipient && merchant.toLowerCase() !== String(expectRecipient).toLowerCase()) {
      throw new Error(`recipient mismatch: server asks to pay ${merchant} but expectRecipient=${expectRecipient}`);
    }
    onEvent({ type: "paying", price: human, to: accept.payTo });
    const orderHash = keccak256(toHex(orderId));
    // V-3 decimals boundary: the x402 quote (accept.maxAmountRequired, asset) is 6-decimal
    // ERC-20 USDC. This Zunivo-router path settles by sending NATIVE Arc USDC (18 decimals)
    // equal to the same human amount — the two happen to be the same asset on Arc, so
    // `parseEther(human)` (18-dec) is correct HERE. Do NOT reuse this value on the ERC-20 /
    // EIP-3009 path, which must use the 6-decimal base units from the quote.
    const hash = await wallet.writeContract({
      address: ROUTER, abi: ROUTER_ABI, functionName: "pay",
      args: [orderHash, merchant], value: parseEther(human), // native 18-dec send (router gas-value path)
    });
    await pub.waitForTransactionReceipt({ hash });
    onEvent({ type: "paid", txHash: hash });

    // 4. retry with X-PAYMENT proof until settlement indexes
    const paymentHeader = encodeHeader({ x402Version: 1, scheme: "exact", network: accept.network, zunivoOrderId: orderId, txHash: hash });
    const deadline = Date.now() + settleTimeoutMs;
    while (Date.now() < deadline) {
      res = await fetch(url, { ...init, headers: { ...(init.headers || {}), "X-PAYMENT": paymentHeader } });
      if (res.status === 200) {
        onEvent({ type: "served", receipt: decodeHeader(res.headers.get("X-PAYMENT-RESPONSE") || "") });
        return res;
      }
      if (res.status !== 402) return res; // real error, surface it
      await new Promise((s) => setTimeout(s, 8000));
    }
    throw new Error("settlement did not confirm before timeout");
  };
}
