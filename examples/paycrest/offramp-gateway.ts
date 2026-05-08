import "dotenv/config";
import {
  Amount,
  ChainId,
  fromAddress,
  Paycrest,
  PaycrestOrderError,
  StarkSigner,
  StarkZap,
  mainnetTokens,
  type Token,
} from "starkzap";

/**
 * Off-ramp 1 stablecoin (USDT by default, USDC opt-in via
 * `PAYCREST_TOKEN`) on Starknet -> NGN bank account, via the on-chain
 * Cairo Gateway path. Requires a real mainnet wallet with the chosen
 * token and an API key from app.paycrest.io.
 *
 * Paycrest is mainnet-only — there is no testnet variant.
 */
async function main() {
  const apiKey = required("PAYCREST_API_KEY");
  const rpcUrl = required("RPC_URL");
  const privateKey = required("PRIVATE_KEY");
  const walletAddress = fromAddress(required("WALLET_ADDRESS"));

  const sdk = new StarkZap({
    rpcUrl,
    chainId: ChainId.MAINNET,
    paycrest: { apiKey },
  });

  const wallet = await sdk.connectWallet({
    accountAddress: walletAddress,
    account: { signer: new StarkSigner(privateKey) },
  });

  await wallet.ensureReady({ deploy: "if_needed" });

  const token = resolveToken();
  const paycrest = new Paycrest({ apiKey });
  const result = await paycrest.offramp(wallet, {
    path: "gateway",
    from: {
      token,
      amount: Amount.parse("1", token),
    },
    to: {
      currency: "NGN",
      recipient: {
        institution: required("RECIPIENT_INSTITUTION"),
        accountIdentifier: required("RECIPIENT_ACCOUNT_IDENTIFIER"),
        accountName: required("RECIPIENT_ACCOUNT_NAME"),
        memo: "starkzap demo",
      },
    },
  });

  console.log("submitted:", result.tx.hash);
  console.log("rate:", result.rate);

  // result.wait() handles the full lifecycle: waits for the L2
  // receipt, parses the on-chain order id, then polls Paycrest until
  // the order reaches a terminal status. For the gateway path it
  // hits /v2/orders/{chain_id}/{gateway_id}; for the api path it
  // hits /v2/sender/orders/{uuid}. Production servers should prefer
  // webhooks via Paycrest.verifyWebhookSignature.
  try {
    const status = await result.wait();
    console.log("orderId:", status.orderId);
    console.log("final status:", status.status);
  } catch (err) {
    if (err instanceof PaycrestOrderError) {
      console.error(
        "order ended in non-success state:",
        err.order.status,
        err.order
      );
      process.exit(2);
    }
    throw err;
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function resolveToken(): Token {
  const symbol = (process.env["PAYCREST_TOKEN"] ?? "USDT").toUpperCase();
  if (symbol === "USDT") return mainnetTokens.USDT;
  if (symbol === "USDC") return mainnetTokens.USDC;
  throw new Error(
    `PAYCREST_TOKEN must be USDC or USDT (got: ${process.env["PAYCREST_TOKEN"]})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
