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
} from "starkzap";

/**
 * Off-ramp via the Sender API path: Paycrest creates the order,
 * returns a `receiveAddress`, and the SDK transfers the tokens to it.
 *
 * Same final outcome as the gateway path, just orchestrated off-chain.
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

  const paycrest = new Paycrest({ apiKey });
  const result = await paycrest.offramp(wallet, {
    path: "api",
    from: {
      token: mainnetTokens.USDC,
      amount: Amount.parse("1", mainnetTokens.USDC),
    },
    to: {
      currency: "NGN",
      recipient: {
        institution: required("RECIPIENT_INSTITUTION"),
        accountIdentifier: required("RECIPIENT_ACCOUNT_IDENTIFIER"),
        accountName: required("RECIPIENT_ACCOUNT_NAME"),
      },
    },
    reference: `demo-${Date.now()}`,
  });

  console.log("orderId:", await result.orderId);
  console.log("receiveAddress:", result.receiveAddress);
  console.log("validUntil:", result.providerAccount?.validUntil);
  console.log("submitted transfer tx:", result.tx.hash);

  // result.wait() polls /v2/sender/orders/{uuid} until terminal
  // (api path uses the UUID, gateway path uses the on-chain id).
  try {
    const status = await result.wait();
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
