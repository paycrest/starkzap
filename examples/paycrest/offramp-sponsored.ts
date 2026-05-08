import "dotenv/config";
import {
  Amount,
  ChainId,
  extractOrderIdFromReceipt,
  fromAddress,
  paycrestGatewayFor,
  PaycrestOrderError,
  StarkSigner,
  StarkZap,
  mainnetTokens,
  type Token,
} from "starkzap";

/**
 * Sponsored gateway-path off-ramp.
 *
 * `wallet.tx().paycrestOfframp(input)` queues the ERC20 `approve` and
 * the Gateway `create_order` calls, then `.send({ feeMode })` submits
 * them as **one atomic multicall** sponsored by the configured
 * paymaster (AVNU by default). The user pays no gas.
 *
 * Set `PAYCREST_GAS_TOKEN=<token symbol>` to pay gas in that token
 * instead of the paymaster covering it. Defaults to fully sponsored.
 *
 * Token defaults to USDT; set `PAYCREST_TOKEN=USDC` to opt into USDC.
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
  const gasToken = resolveOptionalGasToken();

  // The fluent builder makes the batched approve+create_order
  // visually a single chained step. `.send({ feeMode })` sponsors the
  // whole multicall.
  const tx = await wallet
    .tx()
    .paycrestOfframp({
      from: { token, amount: Amount.parse("1", token) },
      to: {
        currency: "NGN",
        recipient: {
          institution: required("RECIPIENT_INSTITUTION"),
          accountIdentifier: required("RECIPIENT_ACCOUNT_IDENTIFIER"),
          accountName: required("RECIPIENT_ACCOUNT_NAME"),
          memo: "starkzap sponsored demo",
        },
      },
    })
    .send({
      feeMode: gasToken
        ? { type: "paymaster", gasToken: gasToken.address }
        : { type: "paymaster" },
    });

  console.log("submitted (sponsored multicall):", tx.hash);

  // Run the off-ramp directly via paycrest.offramp(...) just to access
  // result.wait() — for the sponsored example we already submitted via
  // the builder above, so we poll the gateway endpoint by gateway_id.
  const paycrest = wallet.paycrest();
  await tx.wait();
  console.log("on-chain confirmed. Polling for fiat settlement...");
  const receipt = (await tx.receipt()) as {
    events?: ReadonlyArray<{
      from_address?: string;
      keys?: string[];
      data?: string[];
    }>;
  };
  const orderId = extractOrderIdFromReceipt(
    receipt,
    paycrestGatewayFor(ChainId.MAINNET)
  );
  if (!orderId) {
    throw new Error(
      "no OrderCreated event found on receipt — did the tx revert?"
    );
  }
  console.log("orderId:", orderId);

  try {
    const status = await paycrest.waitForGatewayOrder(orderId);
    console.log("final status:", status.status);
  } catch (err) {
    if (err instanceof PaycrestOrderError) {
      console.error("order ended in:", err.order.status, err.order);
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

function resolveOptionalGasToken(): Token | undefined {
  const symbol = process.env["PAYCREST_GAS_TOKEN"];
  if (!symbol) return undefined;
  const upper = symbol.toUpperCase();
  if (upper === "USDT") return mainnetTokens.USDT;
  if (upper === "USDC") return mainnetTokens.USDC;
  if (upper === "STRK") return mainnetTokens.STRK;
  if (upper === "ETH") return mainnetTokens.ETH;
  throw new Error(
    `PAYCREST_GAS_TOKEN must be one of USDT, USDC, STRK, ETH (got: ${symbol})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
