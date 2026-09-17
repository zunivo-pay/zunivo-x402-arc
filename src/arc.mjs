/**
 * Arc network constants for x402 payments (mainnet + testnet).
 *
 * IMPORTANT decimals note (source: Arc docs):
 *   - Native USDC gas token uses 18 decimals.
 *   - USDC ERC-20 interface (the one x402 / EIP-3009 uses) uses 6 decimals.
 * x402 amounts are ERC-20 amounts → ALWAYS 6 decimals here. Never mix with the
 * 18-decimal native path (that's what our router `pay()` uses for gas-value sends).
 *
 * DEFAULT NETWORK (since 1.0.0): "arc" = Arc MAINNET, real USDC. Pass
 * network:"arc-testnet" explicitly for the free sandbox. Set DEFAULT_NETWORK
 * via env ZUNIVO_NETWORK if you want a process-wide override.
 */
export const DEFAULT_NETWORK = process.env.ZUNIVO_NETWORK || "arc";

export const ARC_TESTNET = {
  chainId: 5042002,
  name: "Arc Testnet",
  rpcUrl: "https://rpc.testnet.arc.network",
  explorer: "https://testnet.arcscan.app",
  // USDC ERC-20 interface (6 decimals) — the token x402 authorizations are signed against.
  usdc: "0x3600000000000000000000000000000000000000",
  usdcDecimals: 6,
  // ArcPayRouter for the Zunivo-order settlement backend (testnet deploy).
  router: "0x4210D40a9899e42b4946B9dC7E0C35d3cf14Ea55",
  // x402 network identifier used in PaymentRequirements.network
  x402Network: "arc-testnet",
  mainnet: false,
  // CAIP-2 identifier — the standards-based name catalogs index by
  // (Circle's Discovery API filters on this form). Emitted alongside the
  // legacy name so both old clients and standards-first tooling match.
  caip2: "eip155:5042002",
};

/**
 * Arc MAINNET — live since 2026-09-16. Every value below was confirmed on-chain
 * (chainId via eth_chainId, USDC/router via the verified v1.3 deployment, see
 * zunivo-contracts/deployments/arc-mainnet-v1.3.json). Real money.
 */
export const ARC_MAINNET = {
  chainId: 5042,
  name: "Arc",
  rpcUrl: process.env.ZUNIVO_MAINNET_RPC_URL || "https://rpc.mainnet.arc.io",
  explorer: "https://arc.etherscan.io",
  // Native USDC's ERC-20 interface (6 decimals) — same address as testnet by design.
  usdc: "0x3600000000000000000000000000000000000000",
  usdcDecimals: 6,
  // ArcPayRouter v1.3 (mainnet), verified on arc.etherscan.io.
  router: "0xAa8c293495446d04a51A32e2e4557EDE3BfC7119",
  x402Network: "arc",
  mainnet: true,
  caip2: "eip155:5042",
};

/** True when a resolved config (or a network name) is Arc MAINNET (real money). */
export function isMainnet(cfgOrName) {
  const cfg = typeof cfgOrName === "string" ? NETWORKS[cfgOrName] : cfgOrName;
  return Boolean(cfg && cfg.mainnet);
}

/** Networks by x402 identifier. Callers pass network:"arc"|"arc-testnet" or the
 *  CAIP-2 form ("eip155:5042" | "eip155:5042002"). Default is MAINNET ("arc"). */
export const NETWORKS = {
  "arc": ARC_MAINNET,
  "arc-testnet": ARC_TESTNET,
  "eip155:5042": ARC_MAINNET,      // CAIP-2 alias (mainnet)
  "eip155:5042002": ARC_TESTNET,   // CAIP-2 alias (testnet)
};

/** True when an x402 `network` value refers to this config (legacy or CAIP-2 form). */
export function networkMatches(cfg, value) {
  return value === cfg.x402Network || (cfg.caip2 !== "" && value === cfg.caip2);
}

/**
 * Resolve a network config by name and REFUSE if it isn't safe to use. A mainnet whose
 * placeholders are still unset throws — you cannot accidentally move real money on a
 * half-configured chain. (MN-1/MN-5)
 */
export function resolveNetwork(network = DEFAULT_NETWORK) {
  const cfg = NETWORKS[network];
  if (!cfg) throw new Error(`unknown network "${network}" (expected "arc", "arc-testnet", "eip155:5042" or "eip155:5042002")`);
  const unset =
    !cfg.chainId ||
    !cfg.rpcUrl ||
    !/^0x[0-9a-fA-F]{40}$/.test(cfg.usdc) ||
    !/^0x[0-9a-fA-F]{40}$/.test(cfg.router);
  if (unset) {
    throw new Error(
      `network "${network}" is not fully configured (chainId/rpcUrl/usdc/router). ` +
      `Fill ARC_MAINNET with real Arc mainnet values before using it — the SDK refuses to ` +
      `move funds on a half-configured network.`,
    );
  }
  return cfg;
}

/**
 * Convert a human USDC string ("0.05") to a 6-decimal base-unit string ("50000").
 * STRICT: only a clean non-negative decimal is accepted. Anything else (scientific
 * notation, commas, hex, signs, whitespace, NaN, >6 dp) throws — never silently
 * produces a garbage amount. Both the server price path and the agent-signing path
 * rely on this, so a malformed amount must fail loud, not settle wrong. (V-5)
 */
export function toUsdcBaseUnits(human) {
  const s = String(human).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`invalid USDC amount "${human}" — expected a non-negative decimal like "0.05"`);
  }
  const [whole, frac = ""] = s.split(".");
  if (frac.length > 6) {
    throw new Error(`USDC amount "${human}" has more than 6 decimal places (base unit is 0.000001)`);
  }
  const fracPadded = (frac + "000000").slice(0, 6);
  const digits = (whole + fracPadded).replace(/^0+(?=\d)/, "");
  return digits === "" ? "0" : digits;
}

/**
 * Convert a 6-decimal base-unit string back to a human USDC string.
 * STRICT: base units are integer base-10; reject anything else so a hostile
 * server-sent maxAmountRequired can't smuggle NaN/negatives past a client's
 * maxPrice check. (V-10/V-11)
 */
export function fromUsdcBaseUnits(base) {
  const s = String(base).trim();
  if (!/^\d+$/.test(s)) {
    throw new Error(`invalid USDC base-unit amount "${base}" — expected a non-negative integer string`);
  }
  const p = s.padStart(7, "0");
  const whole = p.slice(0, -6).replace(/^0+(?=\d)/, "");
  const frac = p.slice(-6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** Compare two USDC amounts exactly as integers (never via float). Returns -1/0/1. (V-11) */
export function cmpBaseUnits(aBase, bBase) {
  const A = BigInt(aBase), B = BigInt(bBase);
  return A < B ? -1 : A > B ? 1 : 0;
}

/** Base64-encode a JSON object (x402 headers carry base64url JSON). */
export function encodeHeader(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

/** Max accepted size for an inbound base64 header payload (DoS guard). (V-8) */
export const MAX_HEADER_B64 = 8192;

/** Decode a base64 JSON header back to an object; returns null on failure or oversize. */
export function decodeHeader(b64) {
  if (typeof b64 !== "string" || b64.length === 0 || b64.length > MAX_HEADER_B64) return null;
  try {
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    return null;
  }
}
