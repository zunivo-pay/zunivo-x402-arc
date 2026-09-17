import test from "node:test";
import assert from "node:assert/strict";
import {
  ARC_MAINNET, ARC_TESTNET, NETWORKS, DEFAULT_NETWORK, resolveNetwork, isMainnet, networkMatches,
  toUsdcBaseUnits, fromUsdcBaseUnits, cmpBaseUnits,
} from "../src/arc.mjs";

test("default network is Arc mainnet unless ZUNIVO_NETWORK overrides", () => {
  assert.equal(DEFAULT_NETWORK, process.env.ZUNIVO_NETWORK || "arc");
  assert.equal(resolveNetwork(), NETWORKS[DEFAULT_NETWORK]);
});

test("mainnet config is fully populated and matches the verified v1.3 deployment", () => {
  assert.equal(ARC_MAINNET.chainId, 5042);
  assert.equal(ARC_MAINNET.caip2, "eip155:5042");
  assert.equal(ARC_MAINNET.router, "0xAa8c293495446d04a51A32e2e4557EDE3BfC7119");
  assert.equal(ARC_MAINNET.usdc, "0x3600000000000000000000000000000000000000");
  assert.equal(ARC_MAINNET.usdcDecimals, 6);
  assert.equal(ARC_MAINNET.mainnet, true);
  assert.doesNotThrow(() => resolveNetwork("arc"));
});

test("testnet config unchanged and reachable by legacy + CAIP-2 names", () => {
  assert.equal(ARC_TESTNET.chainId, 5042002);
  assert.equal(resolveNetwork("arc-testnet"), ARC_TESTNET);
  assert.equal(resolveNetwork("eip155:5042002"), ARC_TESTNET);
  assert.equal(isMainnet("arc-testnet"), false);
});

test("CAIP-2 aliases resolve to the right chain", () => {
  assert.equal(resolveNetwork("eip155:5042"), ARC_MAINNET);
  assert.equal(isMainnet("eip155:5042"), true);
  assert.equal(isMainnet(ARC_MAINNET), true);
});

test("networkMatches accepts legacy and CAIP-2 forms, rejects cross-chain", () => {
  assert.equal(networkMatches(ARC_MAINNET, "arc"), true);
  assert.equal(networkMatches(ARC_MAINNET, "eip155:5042"), true);
  assert.equal(networkMatches(ARC_MAINNET, "arc-testnet"), false);
  assert.equal(networkMatches(ARC_MAINNET, "eip155:5042002"), false);
  assert.equal(networkMatches(ARC_TESTNET, "eip155:5042"), false);
});

test("unknown network throws", () => {
  assert.throws(() => resolveNetwork("base"), /unknown network/);
});

test("USDC base-unit conversions are exact", () => {
  assert.equal(toUsdcBaseUnits("0.05"), "50000");
  assert.equal(toUsdcBaseUnits("1"), "1000000");
  assert.equal(fromUsdcBaseUnits("50000"), "0.05");
  assert.equal(cmpBaseUnits("50000", "50001"), -1);
  assert.throws(() => toUsdcBaseUnits("1e-3"));
  assert.throws(() => toUsdcBaseUnits("0.0000001"));
});
