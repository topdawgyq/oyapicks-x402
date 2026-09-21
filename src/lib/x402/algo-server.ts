// Shared Algorand (AVM) x402 resource server.
// One configured server instance, reused by every Algorand-paid route.
// MAINNET. Facilitator host below is the mainnet-capable GoPlausible host.
import { x402ResourceServer } from "@x402-avm/next";
import { registerExactAvmScheme } from "@x402-avm/avm/exact/server";
import { bazaarResourceServerExtension } from "@x402-avm/extensions/bazaar";
import { HTTPFacilitatorClient } from "@x402-avm/core/server";

// FACILITATOR HOSTS — these are NOT interchangeable:
//   https://facilitator.goplausible.xyz        <- MAINNET-capable (WHAT WE USE)
//   https://x402.goplausible.xyz/facilitator   <- TESTNET only; does NOT advertise
//                                                 algorand mainnet. Using it gives
//                                                 "Facilitator does not support
//                                                  scheme exact on network algorand:..."
// Verify with: curl -s "https://facilitator.goplausible.xyz/supported"
// Override via ALGO_FACILITATOR_URL only if you know why.
const facilitatorClient = new HTTPFacilitatorClient(
  process.env.ALGO_FACILITATOR_URL
    ? { url: process.env.ALGO_FACILITATOR_URL }
    : { url: "https://facilitator.goplausible.xyz" },
);

export const algoServer = new x402ResourceServer(facilitatorClient);

// --- DIAGNOSTIC LOGGING (added to finally see GoPlausible's real response) ---
// Pure instrumentation via x402ResourceServer's own lifecycle hooks. None of
// these abort or recover anything — they only log what already happened, so
// this cannot change payment behavior. Check Vercel's Runtime Logs after any
// Algorand payment attempt to see the real verify/settle result.
algoServer.onAfterVerify(async (ctx) => {
  console.log("[x402 verify]", JSON.stringify({
    isValid: ctx.result.isValid,
    invalidReason: ctx.result.invalidReason,
    invalidMessage: ctx.result.invalidMessage,
    payer: ctx.result.payer,
  }));
});
algoServer.onVerifyFailure(async (ctx) => {
  console.error("[x402 verify FAILED]", ctx.error?.message, ctx.error?.stack);
});
algoServer.onAfterSettle(async (ctx) => {
  console.log("[x402 settle]", JSON.stringify({
    success: ctx.result.success,
    errorReason: ctx.result.errorReason,
    errorMessage: ctx.result.errorMessage,
    payer: ctx.result.payer,
    transaction: ctx.result.transaction,
  }));
});
algoServer.onSettleFailure(async (ctx) => {
  console.error("[x402 settle FAILED]", ctx.error?.message, ctx.error?.stack);
});
registerExactAvmScheme(algoServer);
algoServer.registerExtension(bazaarResourceServerExtension);

// Receiving address (58-char Algorand). Set ALGO_PAY_TO in env.
// Testnet: your demo wallet. Mainnet: your dedicated x402 revenue wallet.
export const ALGO_PAY_TO = process.env.ALGO_PAY_TO ?? "";
