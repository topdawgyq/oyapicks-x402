#!/usr/bin/env node
//
// OyaPicks x402 buyer: pay for one prediction-market data call in USDC on
// Algorand MainNet, then print the data and the on-chain settlement ID.
//
//   Dry run (free, nothing signed, nothing sent):
//     node buyer.mjs single-market-algo "world cup"
//
//   Pay for real:
//     ALGO_MNEMONIC="word1 word2 ... word25" node buyer.mjs single-market-algo "world cup" --pay
//
// Env:
//   ALGO_MNEMONIC     25-word Algorand mnemonic (or use AVM_PRIVATE_KEY)
//   AVM_PRIVATE_KEY   base64 64-byte secret key (alternative to the mnemonic)
//   MAX_USD           refuse to pay more than this per call (default 0.25)
//   OYAPICKS_BASE     default https://oyapicks.app
//   ALGOD_URL         your own Algorand node (default: AlgoNode public MainNet)
//
// The paying wallet needs USDC (ASA 31566704) and a little ALGO for fees.
// Use a throwaway wallet funded with a dollar or two, never your main one.

import algosdk from "algosdk";
import { wrapFetchWithPaymentFromConfig, x402Client, x402HTTPClient } from "@x402-avm/fetch";
import { ExactAvmScheme } from "@x402-avm/avm/exact/client";
import { toClientAvmSigner } from "@x402-avm/avm";

const USDC_DECIMALS = 6;

const PRODUCTS = new Set([
  "alpha-book",
  "analyze-algo",
  "arbitrage-algo",
  "closing-soon-algo",
  "movers-algo",
  "new-markets-algo",
  "probability-history-algo",
  "resolutions-algo",
  "search-algo",
  "single-market-algo",
  "volume-spikes-algo",
]);
const NEEDS_QUERY = new Set(["probability-history-algo", "search-algo", "single-market-algo"]);

function die(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- args ----
const argv = process.argv.slice(2);
const pay = argv.includes("--pay");
const [product, ...rest] = argv.filter((a) => a !== "--pay");
const query = rest.join(" ").trim();

if (!product || !PRODUCTS.has(product)) {
  die(
    `Usage: node buyer.mjs <product> [query] [--pay]\n\n  Products:\n    ${[...PRODUCTS].join("\n    ")}`,
  );
}
if (NEEDS_QUERY.has(product) && !query) die(`${product} needs a keyword, e.g. "world cup"`);

const base = (process.env.OYAPICKS_BASE ?? "https://oyapicks.app").replace(/\/$/, "");
const url = `${base}/api/x402/${product}${query ? `?q=${encodeURIComponent(query)}` : ""}`;
const maxUsd = Number(process.env.MAX_USD ?? "0.25");
if (!(maxUsd > 0)) die("MAX_USD must be a positive number");

const usd = (atomic) => Number(atomic) / 10 ** USDC_DECIMALS;

// ------------------------------------------------ step 1: unpaid request ----
// Ask without paying. The server answers 402 with its payment terms, parsed
// here exactly the way the paying client parses them.
console.log(`\n→ GET ${url}`);
const first = await fetch(url);
if (first.status !== 402) {
  const text = await first.text();
  die(`Expected 402 Payment Required, got ${first.status}.\n  ${text.slice(0, 300)}`);
}

let body;
try {
  const t = await first.text();
  body = t ? JSON.parse(t) : undefined;
} catch {
  body = undefined;
}
const terms = new x402HTTPClient(new x402Client()).getPaymentRequiredResponse(
  (name) => first.headers.get(name),
  body,
);
const avmTerms = terms.accepts.filter((r) => String(r.network).startsWith("algorand:"));
if (!avmTerms.length) die("Server offered no Algorand payment option.");
const req = avmTerms[0];

console.log("\n  402 Payment Required");
console.log(`    price     $${usd(req.amount).toFixed(2)} USDC`);
console.log(`    asset     ASA ${req.asset}`);
console.log(`    network   ${req.network}`);
console.log(`    payTo     ${req.payTo}`);
console.log(`    scheme    ${req.scheme}`);
if (req.extra?.tag) console.log(`    tag       ${req.extra.tag}`);

if (!pay) {
  console.log("\n  Dry run: nothing signed, nothing paid. Add --pay to buy.\n");
  process.exit(0);
}

// --------------------------------------------------- step 2: spend cap ----
// Enforced twice: here for a clear message, and as a client policy below so
// the signer itself can never be handed terms above the cap.
if (usd(req.amount) > maxUsd) {
  die(`Price $${usd(req.amount)} is above MAX_USD $${maxUsd}. Not paying.`);
}
const underCap = (_v, reqs) => reqs.filter((r) => usd(r.amount) <= maxUsd);

// ----------------------------------------------------------- step 3: key ----
let b64Key = process.env.AVM_PRIVATE_KEY;
if (!b64Key && process.env.ALGO_MNEMONIC) {
  try {
    const { sk } = algosdk.mnemonicToSecretKey(process.env.ALGO_MNEMONIC.trim());
    b64Key = Buffer.from(sk).toString("base64");
  } catch (e) {
    die(`ALGO_MNEMONIC is not a valid 25-word Algorand mnemonic (${e.message}).`);
  }
}
if (!b64Key) die("Set ALGO_MNEMONIC (or AVM_PRIVATE_KEY) to pay.");
const signer = toClientAvmSigner(b64Key);
console.log(`\n  Paying from ${signer.address}`);

// --------------------------------------------------- step 4: pay + fetch ----
const paidFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [
    {
      network: "algorand:*",
      // Pass the node here. The ALGOD_MAINNET_URL env var in the package
      // README is not read by this client (verified against 2.6.1).
      client: new ExactAvmScheme(
        signer,
        process.env.ALGOD_URL ? { algodUrl: process.env.ALGOD_URL } : undefined,
      ),
    },
  ],
  policies: [underCap],
});

let res;
try {
  res = await paidFetch(url);
} catch (e) {
  // Signing or submitting failed before the server ever saw a payment.
  die(
    `Could not complete payment: ${e.message}\n` +
      "  Common causes: wallet not opted in to USDC (ASA 31566704),\n" +
      "  not enough USDC, or not enough ALGO for the network fee.",
  );
}
const data = await res.json().catch(() => null);

if (!res.ok) {
  // The server only settles on success, so a failed call costs nothing.
  die(`Call failed with ${res.status}. No payment was settled.\n  ${JSON.stringify(data)}`);
}

// ------------------------------------------- step 5: proof of settlement ----
// Don't trust the 200. Print the on-chain transaction so anyone can check it.
let settle = null;
try {
  settle = new x402HTTPClient(new x402Client()).getPaymentSettleResponse((n) => res.headers.get(n));
} catch {
  settle = null;
}

console.log("\n  Data:");
console.log(JSON.stringify(data, null, 2).replace(/^/gm, "    "));

if (settle?.transaction) {
  console.log(`\n  Settled on-chain: ${settle.transaction}`);
  console.log(`  Verify: https://lora.algokit.io/mainnet/transaction/${settle.transaction}\n`);
} else {
  console.log("\n  Warning: 200 received but no settlement header found. Check your wallet history.\n");
}
