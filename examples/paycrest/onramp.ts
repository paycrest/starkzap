import "dotenv/config";
import { fromAddress, Paycrest, StarkZap, mainnetTokens } from "starkzap";

/**
 * On-ramp 50000 NGN -> USDC delivered to a Starknet wallet.
 *
 * On-ramp is Sender-API-only — Paycrest does not support on-ramp via
 * the Cairo Gateway. The response carries the bank account the user
 * must transfer fiat into; tokens are delivered after the transfer is
 * verified.
 */
async function main() {
  const apiKey = required("PAYCREST_API_KEY");
  const walletAddress = fromAddress(required("WALLET_ADDRESS"));

  // No wallet connection needed for on-ramp; the SDK is only used to
  // hold the chainId/network identifier. You can also just construct
  // `new Paycrest(...)` directly.
  void new StarkZap({ network: "mainnet", paycrest: { apiKey } });

  const paycrest = new Paycrest({ apiKey });
  const result = await paycrest.onramp({
    from: {
      currency: "NGN",
      amount: 50_000,
      refundAccount: {
        institution: required("RECIPIENT_INSTITUTION"),
        accountIdentifier: required("RECIPIENT_ACCOUNT_IDENTIFIER"),
        accountName: required("RECIPIENT_ACCOUNT_NAME"),
      },
    },
    to: { token: mainnetTokens.USDC, recipient: walletAddress },
    reference: `onramp-${Date.now()}`,
  });

  console.log("Pay this account to fund your wallet:");
  console.log(`  bank:     ${result.providerAccount.institution}`);
  console.log(`  account:  ${result.providerAccount.accountIdentifier}`);
  console.log(`  name:     ${result.providerAccount.accountName}`);
  console.log(
    `  amount:   ${result.providerAccount.amountToTransfer} ${result.providerAccount.currency}`
  );
  console.log(`  expires:  ${result.validUntil}`);
  console.log(`Order id:   ${result.orderId}`);
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
