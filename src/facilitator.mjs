/**
 * EIP-3009 facilitator for x402 on Arc (gasless path).
 *
 * The agent signs a TransferWithAuthorization; the facilitator submits it to the USDC
 * contract, which checks the signature and moves the funds.
 *
 * Reference implementation against Circle's FiatTokenV2 schema. Confirm the 3009
 * selectors and EIP-712 domain on Arc before using this in production; the order
 * backend in middleware.mjs is the path that's been exercised on mainnet.
 */
import {
  createWalletClient, createPublicClient, http, parseAbi, defineChain,
  verifyTypedData, parseSignature,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolveNetwork, DEFAULT_NETWORK, toUsdcBaseUnits } from "./arc.mjs";

function chainFor(network) {
  const NET = resolveNetwork(network);
  return { NET, chain: defineChain({
    id: NET.chainId, name: NET.name,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [NET.rpcUrl] } },
  }) };
}

const USDC_3009_ABI = parseAbi([
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
  "function receiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
  "function name() view returns (string)",
  "function version() view returns (string)",
]);

const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

async function domain(pub, NET) {
  // name/version are read from the contract when available
  let name = "USDC", version = "2";
  try { name = await pub.readContract({ address: NET.usdc, abi: USDC_3009_ABI, functionName: "name" }); } catch {}
  try { version = await pub.readContract({ address: NET.usdc, abi: USDC_3009_ABI, functionName: "version" }); } catch {}
  return { name, version, chainId: NET.chainId, verifyingContract: NET.usdc };
}

/** Agent side: sign a TransferWithAuthorization for an x402 `exact` payment. */
export async function signPayment({ privateKey, to, price, validForSeconds = 300, network = DEFAULT_NETWORK }) {
  const account = privateKeyToAccount(privateKey);
  const { NET, chain } = chainFor(network);
  const pub = createPublicClient({ chain, transport: http() });
  const now = Math.floor(Date.now() / 1000);
  const message = {
    from: account.address,
    to,
    value: BigInt(toUsdcBaseUnits(price)),
    validAfter: 0n,
    validBefore: BigInt(now + validForSeconds),
    nonce: randomNonce(),
  };
  const signature = await account.signTypedData({
    domain: await domain(pub, NET), types: TYPES, primaryType: "TransferWithAuthorization", message,
  });
  return { scheme: "exact", network: NET.x402Network, authorization: serialize(message), signature };
}

/** Facilitator side: verify the signature, then submit it on Arc. */
export function createFacilitator({ submitterKey, network = DEFAULT_NETWORK }) {
  const { NET, chain } = chainFor(network);
  // Submits signed authorizations straight to the USDC contract. Confirm the selectors and
  // EIP-712 domain on the target chain before relying on this with real money.
  const pub = createPublicClient({ chain, transport: http() });
  const submitter = submitterKey
    ? createWalletClient({ account: privateKeyToAccount(submitterKey), chain, transport: http() })
    : null;

  // Shared check (recipient, amount, time window, signature). Both verify() and settle() run it.
  async function check(payload, accept) {
    if (!payload?.authorization || !payload?.signature) return { ok: false, status: "malformed payload" };
    let a;
    try { a = deserialize(payload.authorization); } catch { return { ok: false, status: "malformed authorization" }; }
    if (accept) {
      if (String(a.to).toLowerCase() !== String(accept.payTo).toLowerCase()) return { ok: false, status: "wrong recipient" };
      if (a.value < BigInt(accept.maxAmountRequired)) return { ok: false, status: "underpaid" };
    }
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (a.validAfter && now < a.validAfter) return { ok: false, status: "authorization not yet valid" };
    if (a.validBefore && now >= a.validBefore) return { ok: false, status: "authorization expired" };
    let sigOk = false;
    try {
      sigOk = await verifyTypedData({
        address: a.from, domain: await domain(pub, NET), types: TYPES,
        primaryType: "TransferWithAuthorization", message: a, signature: payload.signature,
      });
    } catch { sigOk = false; }
    if (!sigOk) return { ok: false, status: "bad signature" };
    return { ok: true, authorization: a };
  }

  return {
    async verify(payload, accept) {
      const r = await check(payload, accept);
      return r.ok
        ? { settled: false, status: "signature valid, awaiting submit", authorization: r.authorization }
        : { settled: false, status: r.status };
    },
    async settle(payload, accept) {
      if (!submitter) throw new Error("facilitator has no submitterKey to pay gas");
      // re-check before submitting
      const r = await check(payload, accept);
      if (!r.ok) throw new Error(`refusing to settle: ${r.status}`);
      const a = r.authorization;
      // viem handles 65-byte and EIP-2098 compact signatures
      const { r: sr, s: ss, v: sv, yParity } = parseSignature(payload.signature);
      const v = sv ?? (yParity != null ? BigInt(yParity) + 27n : undefined);
      if (v == null) throw new Error("signature missing v/yParity");
      // receiveWithAuthorization when the submitter is the payee (the token requires
      // msg.sender == payee, so nobody else can burn the nonce). Otherwise transferWithAuthorization.
      const submitterAddr = submitter.account.address.toLowerCase();
      const fnName = submitterAddr === String(a.to).toLowerCase()
        ? "receiveWithAuthorization"
        : "transferWithAuthorization";
      const hash = await submitter.writeContract({
        address: NET.usdc, abi: USDC_3009_ABI, functionName: fnName,
        args: [a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, Number(v), sr, ss],
      });
      await pub.waitForTransactionReceipt({ hash });
      return { settled: true, txHash: hash };
    },
  };
}

// ---- helpers ----
function randomNonce() {
  const b = new Uint8Array(32); crypto.getRandomValues(b);
  return ("0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join(""));
}
function serialize(m) { return { ...m, value: m.value.toString(), validAfter: m.validAfter.toString(), validBefore: m.validBefore.toString() }; }
function deserialize(m) { return { ...m, value: BigInt(m.value), validAfter: BigInt(m.validAfter), validBefore: BigInt(m.validBefore) }; }

