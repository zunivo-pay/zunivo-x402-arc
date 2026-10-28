/**
 * x402 client. Wraps fetch so a 402 gets paid on Arc and the request is retried.
 *
 *   import { createX402Fetch } from "zunivo-x402-arc/client";
 *   const x402fetch = createX402Fetch({ privateKey: process.env.AGENT_PK });  // mainnet by default
 *   // createX402Fetch({ privateKey, network: "arc-testnet" }) for the sandbox
 *   const res = await x402fetch("https://api.example.dev/v1/data");
 *
 * Pays a Zunivo order through the ArcPayRouter and retries with { zunivoOrderId }
 * in X-PAYMENT. See facilitator.mjs for the EIP-3009 signature variant.
 */
import {
  createWalletClient, createPublicClient, http, parseEther,
  keccak256, toHex, parseAbi, defineChain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolveNetwork, networkMatches, isMainnet, DEFAULT_NETWORK, encodeHeader, decodeHeader, fromUsdcBaseUnits, toUsdcBaseUnits, cmpBaseUnits } from "./arc.mjs";

const ROUTER_ABI = parseAbi(["function pay(bytes32 orderId, address merchant) payable"]);

export function createX402Fetch({
  privateKey, maxPrice, expectRecipient,
  network = DEFAULT_NETWORK,         // "arc" (mainnet, default since 1.0.0) or "arc-testnet"
  requireExpectRecipient = false,    // refuse to pay unless expectRecipient is set
  onEvent = () => {}, settleTimeoutMs = 120_000,
}) {
  if (!privateKey) throw new Error("createX402Fetch: privateKey required");
  const NET = resolveNetwork(network);              // throws on unknown / half-configured mainnet
  const ROUTER = NET.router;
  // On mainnet the server's payTo is real money. Nudge callers to pin the recipient.
  if (isMainnet(NET) && !expectRecipient && !requireExpectRecipient) {
    // warn via event; callers should set expectRecipient
    onEvent({ type: "warn", message: "mainnet without expectRecipient: paying whatever address the server quotes" });
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
    const accepts = Array.isArray(req?.accepts) ? req.accepts : [];
    if (accepts.length === 0) throw new Error("402 without usable PaymentRequirements");
    // The server may list the same offer under the legacy name and the CAIP-2 id.
    // Take the first entry for a network this agent is configured for.
    const accept = accepts.find((a) => !a?.network || networkMatches(NET, a.network));
    if (!accept) {
      const quoted = accepts.map((a) => a?.network).filter(Boolean).join(", ") || "(none)";
      throw new Error(`network mismatch: server quoted [${quoted}] but agent is on "${NET.x402Network}"`);
    }

    // Parse the server amount strictly and compare against maxPrice as BigInt base units,
    // so a malformed or NaN value can't get past the cap.
    let requiredBase;
    try {
      requiredBase = BigInt(accept.maxAmountRequired);
      if (requiredBase < 0n) throw new Error("negative");
    } catch {
      throw new Error(`server sent an invalid amount: ${JSON.stringify(accept.maxAmountRequired)}`);
    }
    // No matching accepts entry means a network mismatch; don't settle.
    const human = fromUsdcBaseUnits(requiredBase.toString());
    onEvent({ type: "quote", price: human, network: accept.network, payTo: accept.payTo });
    if (maxPrice != null) {
      const capBase = BigInt(toUsdcBaseUnits(String(maxPrice)));   // strict-parses maxPrice too
      if (cmpBaseUnits(requiredBase, capBase) > 0) {
        throw new Error(`price ${human} USDC exceeds maxPrice ${maxPrice}`);
      }
    }

    // 3. pay the order through the router
    const orderId = accept.extra?.zunivoOrderId;
    if (!orderId) throw new Error("Zunivo backend expected extra.zunivoOrderId in requirements");
    // Settle to the resolved address. The server resolves .agent names and returns
    // extra.payToAddress; payTo is only usable if it's already a 0x address.
    const merchant = accept.extra?.payToAddress || accept.payTo;
    if (!/^0x[0-9a-fA-F]{40}$/.test(merchant)) {
      throw new Error(`cannot settle: merchant address unresolved (got "${merchant}"). The paid endpoint must expose extra.payToAddress.`);
    }
    // Optional recipient pinning: refuse a server that swaps in a different payee.
    if (expectRecipient && merchant.toLowerCase() !== String(expectRecipient).toLowerCase()) {
      throw new Error(`recipient mismatch: server asks to pay ${merchant} but expectRecipient=${expectRecipient}`);
    }
    onEvent({ type: "paying", price: human, to: accept.payTo });
    const orderHash = keccak256(toHex(orderId));
    // The quote is in 6-decimal ERC-20 units. The router path sends native USDC, which is
    // 18 decimals on Arc, so parseEther(human) is right here. The EIP-3009 path must use
    // the 6-decimal base units from the quote instead.
    const hash = await wallet.writeContract({
      address: ROUTER, abi: ROUTER_ABI, functionName: "pay",
      args: [orderHash, merchant], value: parseEther(human),
    });
    await pub.waitForTransactionReceipt({ hash });
    onEvent({ type: "paid", txHash: hash });

    // 4. retry with X-PAYMENT until the server sees the settlement
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
