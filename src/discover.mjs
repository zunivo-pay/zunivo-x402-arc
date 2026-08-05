/**
 * discover.mjs — the service-discovery half of the Zunivo network.
 *
 * A .agent name is more than a payment route: its holder can publish text
 * records (ZunivoAgentRecords on Arc) that describe a callable service —
 * endpoint URL, x402 manifest, description. This module lets an agent go
 * from a human-readable name to a paid API call in two lines:
 *
 *   const data = await connectAgent("data.agent", { privateKey: AGENT_PK });
 *   const res  = await data.fetch("/v1/index/crypto");   // 402 handled, USDC paid
 *
 * Standard record keys: "url", "x402", "description", "avatar".
 */
import { createPublicClient, http, parseAbi } from "viem";
import { createX402Fetch } from "./client.mjs";

export const STANDARD_KEYS = ["url", "x402", "description", "avatar"];

const RECORDS_ABI = parseAbi([
  "function texts(string label, string[] keys) view returns (string[] values)",
]);
const NAMES_ABI = parseAbi([
  "function resolve(string label) view returns (address)",
]);

const DEFAULTS = {
  rpcUrl: process.env.ZUNIVO_RPC_URL ?? "https://rpc.testnet.arc.network",
  recordsAddress: process.env.ZUNIVO_RECORDS_ADDRESS ?? "",
  namesAddress: process.env.ZUNIVO_NAMES_ADDRESS ?? "0x244e0c8bE1Ed59636901F98920413d414B158cc5",
};

/** "data.agent" | "@data" | "data" → "data" (or null if invalid) */
export function parseAgentName(input) {
  let s = String(input ?? "").trim().toLowerCase();
  if (s.startsWith("@")) s = s.slice(1);
  if (s.endsWith(".agent")) s = s.slice(0, -6);
  return /^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$/.test(s) ? s : null;
}

/**
 * Read an agent's card from chain: records + payout address.
 * Returns { name, label, address, records, endpoint }.
 */
export async function discoverAgent(name, opts = {}) {
  const { rpcUrl, recordsAddress, namesAddress, client } = { ...DEFAULTS, ...opts };
  const label = parseAgentName(name);
  if (!label) throw new Error(`discoverAgent: invalid agent name "${name}"`);
  if (!recordsAddress) {
    throw new Error("discoverAgent: recordsAddress required (opts.recordsAddress or ZUNIVO_RECORDS_ADDRESS)");
  }
  const pub = client ?? createPublicClient({ transport: http(rpcUrl) });

  const [values, address] = await Promise.all([
    pub.readContract({ address: recordsAddress, abi: RECORDS_ABI, functionName: "texts", args: [label, STANDARD_KEYS] }),
    pub.readContract({ address: namesAddress, abi: NAMES_ABI, functionName: "resolve", args: [label] }),
  ]);

  const zero = "0x0000000000000000000000000000000000000000";
  if (address === zero) throw new Error(`discoverAgent: ${label}.agent is not registered`);

  const records = {};
  STANDARD_KEYS.forEach((k, i) => { if (values[i]) records[k] = values[i]; });

  return {
    name: `${label}.agent`,
    label,
    address,          // where this agent's USDC lands
    records,
    endpoint: records.url ?? null,
  };
}

/**
 * Discover + connect in one step: returns the agent card plus a `fetch`
 * bound to the agent's endpoint with x402 payments handled automatically.
 */
export async function connectAgent(name, { privateKey, maxPrice, ...discoverOpts } = {}) {
  const card = await discoverAgent(name, discoverOpts);
  if (!card.endpoint) {
    throw new Error(`connectAgent: ${card.name} has not published a service endpoint ("url" record)`);
  }
  if (!privateKey) throw new Error("connectAgent: privateKey required to pay for calls");
  const paidFetch = createX402Fetch({ privateKey, maxPrice, expectRecipient: card.address });
  return {
    ...card,
    fetch: (path = "", init) => paidFetch(new URL(path, card.endpoint).toString(), init),
  };
}
