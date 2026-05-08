import type { Address } from "@/types/address";
import type { Amount } from "@/types/amount";
import type { Token } from "@/types/token";
import type { ExecuteOptions } from "@/types/wallet";
import type { Tx } from "@/tx";
import type { Call } from "starknet";

/**
 * Networks recognised by the Paycrest backend. The Sender API uses these
 * literals in `source.network` / `destination.recipient.network` and as
 * the `{network}` path segment in the rates endpoint.
 */
export type PaycrestNetwork =
  | "starknet"
  | "ethereum"
  | "base"
  | "arbitrum-one"
  | "polygon"
  | "bnb-smart-chain"
  | "lisk"
  | "celo"
  | "scroll"
  | "asset-chain";

/** Off-ramp transport: on-chain via the Cairo Gateway, or REST via the Sender API. */
export type PaycrestPath = "gateway" | "api";

/**
 * Wire format returned by `GET /v2/tokens`. Contract addresses are returned
 * as raw strings — callers should pass them through `fromAddress()` before
 * using them as Starknet contract addresses.
 */
export interface PaycrestToken {
  symbol: string;
  contractAddress: string;
  decimals: number;
  baseCurrency: string;
  network: PaycrestNetwork;
}

/** Wire format returned by `GET /v2/currencies`. */
export interface PaycrestCurrency {
  code: string;
  name: string;
  shortName: string;
  decimals: number;
  symbol: string;
  marketBuyRate: string;
  marketSellRate: string;
}

/** Wire format returned by `GET /v2/institutions/{currencyCode}`. */
export interface PaycrestInstitution {
  name: string;
  code: string;
  type: "bank" | "mobile_money";
}

/** Wire format returned by `GET /v2/rates/{network}/{token}/{amount}/{fiat}`. */
export interface PaycrestRate {
  buy?: PaycrestRateSide;
  sell?: PaycrestRateSide;
}

export interface PaycrestRateSide {
  rate: string;
  providerIds: string[];
  orderType: string;
  refundTimeoutMinutes: number;
}

/** Bank or mobile-money destination on the off-ramp side. */
export interface PaycrestRecipient {
  /** SWIFT code or Paycrest institution code (suffix `PC`). */
  institution: string;
  /** Bank account number or mobile-money number. */
  accountIdentifier: string;
  /** Account holder's verified name. */
  accountName: string;
  /** Optional payment memo / narration. */
  memo?: string;
}

/** Fiat refund destination for an on-ramp order, used if the order can't be fulfilled. */
export interface PaycrestRefundAccount {
  institution: string;
  accountIdentifier: string;
  accountName: string;
}

/** Sub-status payment_order webhook event names. */
export type PaycrestWebhookEventName =
  | "payment_order.deposited"
  | "payment_order.pending"
  | "payment_order.validated"
  | "payment_order.settling"
  | "payment_order.settled"
  | "payment_order.refunding"
  | "payment_order.refunded"
  | "payment_order.expired";

export type PaycrestOrderStatus =
  | "initiated"
  | "pending"
  | "deposited"
  | "validated"
  | "settling"
  | "settled"
  | "refunding"
  | "refunded"
  | "expired";

/**
 * Account details surfaced by the Sender API after creating an order.
 *
 * For off-ramp orders this carries `receiveAddress` (the on-chain address
 * the app must send tokens to). For on-ramp orders this carries the
 * institution + account number the user must transfer fiat into, plus
 * `amountToTransfer` and `currency`.
 */
export interface PaycrestProviderAccount {
  network?: PaycrestNetwork;
  receiveAddress?: string;
  institution?: string;
  accountIdentifier?: string;
  accountName?: string;
  amountToTransfer?: string;
  currency?: string;
  validUntil?: string;
}

/** Generic order shape returned by the Sender API. */
export interface PaycrestOrder {
  id: string;
  direction?: "onramp" | "offramp";
  status: PaycrestOrderStatus;
  amount?: string;
  txHash?: string;
  reference?: string;
  providerAccount?: PaycrestProviderAccount;
  validUntil?: string;
  [key: string]: unknown;
}

/**
 * Smaller shape returned by `GET /v2/orders/{chain_id}/{gateway_id}`
 * (the aggregator's `GetProviderOrderStatus` endpoint). Used to look
 * up gateway-path off-ramp orders by their on-chain felt252 id when
 * the DB UUID isn't known.
 *
 * Field set is a subset of `PaycrestOrder` — there's no `id` (UUID),
 * no `providerAccount`, no `direction`. The `orderId` field carries
 * the gateway_id you used to look it up.
 */
export interface PaycrestProviderOrderStatus {
  orderId: string;
  status: PaycrestOrderStatus;
  amount?: string;
  amountInUSD?: string;
  token?: string;
  network?: PaycrestNetwork | string;
  txHash?: string;
  settlements?: unknown[];
  txReceipts?: unknown[];
  [key: string]: unknown;
}

/**
 * Unified result returned by `OfframpResult.wait()` — abstracts over
 * the two endpoints used internally (`/v2/sender/orders/{id}` for the
 * api path, `/v2/orders/{chain_id}/{gateway_id}` for the gateway
 * path). The `raw` field carries the underlying response if you need
 * fields beyond status/txHash.
 */
export interface PaycrestOfframpStatus {
  path: PaycrestPath;
  /** Whichever id was used to look up the order (UUID for api, felt252 for gateway). */
  orderId: string;
  status: PaycrestOrderStatus;
  txHash?: string;
  raw: PaycrestOrder | PaycrestProviderOrderStatus;
}

/** Webhook payload posted to the configured endpoint by the Paycrest backend. */
export interface PaycrestWebhookPayload {
  event: PaycrestWebhookEventName;
  webhookVersion: string;
  data: PaycrestOrder;
}

/**
 * Pluggable encryptor used for the Gateway path. The default implementation
 * is RSA-OAEP-SHA256 backed by `crypto.subtle` in browsers/RN and
 * `node:crypto.publicEncrypt` in Node — see `encryption.ts`. Inject a custom
 * function only if you need a non-default RSA library.
 */
export type PaycrestEncryptor = (
  publicKeyPem: string,
  plaintext: string
) => Promise<string>;

/**
 * Per-instance options accepted by `new Paycrest(...)`. Most apps will
 * supply `apiKey` only; the rest are escape hatches for testing, custom
 * deployments, or non-standard runtimes.
 */
export interface PaycrestOptions {
  /** Paycrest API key. Required for any order-creating call. */
  apiKey?: string;
  /** Paycrest API secret. Required only for `Paycrest.verifyWebhookSignature`. */
  apiSecret?: string;
  /** Override the API base URL. Defaults to `https://api.paycrest.io`. */
  apiBaseUrl?: string;
  /**
   * Override the Cairo Gateway contract address. Defaults to the
   * mainnet preset. Useful for local forking or future redeployments.
   */
  gatewayAddress?: Address;
  /** Inject a `fetch` implementation (testing or custom HTTP runtime). */
  fetch?: typeof fetch;
  /** Inject a custom recipient encryptor (default: built-in RSA-OAEP-SHA256). */
  encryptRecipient?: PaycrestEncryptor;
  /** Per-request timeout in milliseconds. Defaults to 15000. */
  requestTimeoutMs?: number;
}

/**
 * Input to `Paycrest.offramp(wallet, input)`.
 *
 * `path` defaults to `"gateway"`. The two paths surface the same shape
 * to the caller; internally:
 *   - `gateway` path: encrypts recipient details, fetches a rate, and
 *     emits an approve + create_order Call pair on-chain.
 *   - `api` path: POSTs to `/v2/sender/orders`, returns the receive
 *     address, and emits a single ERC20 transfer Call to that address.
 */
export interface OfframpInput {
  path?: PaycrestPath;
  from: {
    token: Token;
    amount: Amount;
  };
  to: {
    currency: string;
    recipient: PaycrestRecipient;
  };
  /** App-side identifier echoed back on the order and webhook. Optional. */
  reference?: string;
  /**
   * Optional pre-fetched rate. Used only for the API path; the gateway
   * path always fetches its own rate from `/v2/rates`.
   */
  rate?: string;
  /**
   * Optional sender fee (gateway path only). Defaults to zero address +
   * `0n`. When set, the approve amount is `amount + senderFee`.
   */
  senderFee?: {
    recipient: Address;
    amount: bigint;
  };
}

/** Input to `Paycrest.onramp(input)`. On-ramp is API-path only. */
export interface OnrampInput {
  from: {
    currency: string;
    /** Fiat amount as a stringified or numeric value (Paycrest accepts both). */
    amount: string | number;
    refundAccount: PaycrestRefundAccount;
  };
  to: {
    token: Token;
    recipient: Address;
  };
  reference?: string;
}

/** Result returned by `Paycrest.offramp(...)`. */
export interface OfframpResult {
  path: PaycrestPath;
  /**
   * Resolves to the order id once it's known.
   *
   * - **api path**: resolves immediately to the UUID returned by `POST
   *   /v2/sender/orders` — already known when `offramp()` returns.
   * - **gateway path**: resolves to the felt252 hex order id parsed
   *   from the `OrderCreated` event after the transaction confirms.
   *   Internally waits for the L2 receipt; you do **not** need to call
   *   `tx.wait()` separately before awaiting `orderId`. Resolves to
   *   `null` if the receipt has no `OrderCreated` event (e.g. tx
   *   reverted — check `tx.wait()` for the failure reason).
   */
  orderId: Promise<string | null>;
  tx: Tx;
  /** Underlying calls executed (returned for inspection / re-use). */
  calls: Call[];
  /** Sender API order metadata (api path only). */
  providerAccount?: PaycrestProviderAccount;
  /** ERC20 receive address on the api path. */
  receiveAddress?: string;
  /** Rate used for the order (gateway path only — string from `/v2/rates`). */
  rate?: string;
  /**
   * Wait for fiat settlement. Polls the correct aggregator endpoint
   * based on `path`:
   *
   * - **api path** uses `GET /v2/sender/orders/{uuid}` (full order).
   * - **gateway path** uses `GET /v2/orders/{chain_id}/{gateway_id}`
   *   (smaller status-only shape — the Sender API endpoint doesn't
   *   index gateway_id).
   *
   * Resolves with the unified status when a success terminal is
   * reached (`validated` or `settled`); throws `PaycrestOrderError`
   * on `refunded` / `expired`. See `PaycrestWaitForOrderOptions` for
   * tuning.
   */
  wait(options?: PaycrestWaitForOrderOptions): Promise<PaycrestOfframpStatus>;
}

/** Result returned by `Paycrest.onramp(...)`. */
export interface OnrampResult {
  orderId: string;
  status: PaycrestOrderStatus;
  providerAccount: PaycrestProviderAccount;
  validUntil?: string;
  reference?: string;
}

/** Re-export `ExecuteOptions` so callers don't need to dig into `@/types`. */
export type PaycrestExecuteOptions = ExecuteOptions;

/**
 * Options for `Paycrest.waitForOrder(...)`. Mirrors the shape of
 * `Tx.wait(WaitOptions)` — pass `successStates: []` to disable the
 * built-in success terminals, or `errorStates: []` to never throw on
 * refund/expiry (the order is returned regardless).
 */
export interface PaycrestWaitForOrderOptions {
  /**
   * Statuses that resolve the wait as success.
   * Default: `["validated", "settled"]`.
   *
   * Off-ramp completion is conventionally `validated` (provider has
   * confirmed fiat delivery); on-ramp completion is `settled` (tokens
   * released). The default covers both directions.
   */
  successStates?: PaycrestOrderStatus[];
  /**
   * Statuses that reject the wait as failure.
   * Default: `["refunded", "expired"]`.
   */
  errorStates?: PaycrestOrderStatus[];
  /** Polling interval in milliseconds. Default: 5000. */
  pollIntervalMs?: number;
  /** Total wait timeout in milliseconds. Default: 600000 (10 min). */
  timeoutMs?: number;
  /** AbortSignal to cancel the wait early. */
  signal?: AbortSignal;
}

/**
 * On-chain `Order` struct returned by the Cairo Gateway's `get_order_info`.
 * Mirrors `paycrest::interfaces::IGateway::Order`.
 */
export interface PaycrestOrderInfo {
  sender: Address;
  token: Address;
  senderFeeRecipient: Address;
  senderFee: bigint;
  protocolFee: bigint;
  isFulfilled: boolean;
  isRefunded: boolean;
  refundAddress: Address;
  currentBps: bigint;
  amount: bigint;
}
