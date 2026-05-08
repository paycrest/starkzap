import { assertSafeHttpUrl } from "@/utils";
import type {
  PaycrestCurrency,
  PaycrestInstitution,
  PaycrestNetwork,
  PaycrestOrder,
  PaycrestProviderOrderStatus,
  PaycrestRate,
  PaycrestToken,
} from "@/paycrest/types";

export const PAYCREST_API_BASE_DEFAULT = "https://api.paycrest.io";
const DEFAULT_TIMEOUT_MS = 15_000;

export interface PaycrestApiOptions {
  apiBaseUrl?: string;
  apiKey?: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

interface PaycrestEnvelope<T> {
  status: string;
  message?: string;
  data: T;
}

/**
 * Thin REST client for the Paycrest Sender API. Mirrors the HTTP pattern
 * used by `src/signer/privy.ts` — URL validation up front, AbortController
 * timeout, JSON-error extraction with multiple fallback keys.
 *
 * Unauthenticated endpoints (currencies, institutions, tokens, rates,
 * pubkey) work without an API key; order-creating endpoints require one.
 */
export class PaycrestApi {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: PaycrestApiOptions = {}) {
    const rawBase = options.apiBaseUrl ?? PAYCREST_API_BASE_DEFAULT;
    this.baseUrl = assertSafeHttpUrl(rawBase, "PaycrestOptions.apiBaseUrl")
      .toString()
      .replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetcher =
      options.fetch ??
      ((url: RequestInfo | URL, init?: RequestInit) => fetch(url, init));
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** RSA public key (PEM) used to encrypt recipient details on the gateway path. */
  async getPublicKey(): Promise<string> {
    const env = await this.request<string>("/v2/pubkey", { method: "GET" });
    return env;
  }

  async getCurrencies(): Promise<PaycrestCurrency[]> {
    return this.request<PaycrestCurrency[]>("/v2/currencies", {
      method: "GET",
    });
  }

  async getInstitutions(currencyCode: string): Promise<PaycrestInstitution[]> {
    if (!currencyCode) {
      throw new Error("Paycrest.getInstitutions: currencyCode is required");
    }
    return this.request<PaycrestInstitution[]>(
      `/v2/institutions/${encodeURIComponent(currencyCode)}`,
      { method: "GET" }
    );
  }

  async getTokens(network?: PaycrestNetwork): Promise<PaycrestToken[]> {
    const path = network
      ? `/v2/tokens?network=${encodeURIComponent(network)}`
      : "/v2/tokens";
    return this.request<PaycrestToken[]>(path, { method: "GET" });
  }

  async getRate(args: {
    network: PaycrestNetwork;
    token: string;
    amount: string | number;
    fiat: string;
    side?: "buy" | "sell";
    providerId?: string;
  }): Promise<PaycrestRate> {
    const { network, token, amount, fiat, side, providerId } = args;
    const params = new URLSearchParams();
    if (side) params.set("side", side);
    if (providerId) params.set("provider_id", providerId);
    const query = params.toString();
    const path = `/v2/rates/${encodeURIComponent(network)}/${encodeURIComponent(token)}/${encodeURIComponent(String(amount))}/${encodeURIComponent(fiat)}${query ? `?${query}` : ""}`;
    return this.request<PaycrestRate>(path, { method: "GET" });
  }

  async createOrder(
    body: unknown,
    options?: { signal?: AbortSignal }
  ): Promise<PaycrestOrder> {
    this.requireApiKey("createOrder");
    return this.request<PaycrestOrder>(
      "/v2/sender/orders",
      { method: "POST", body: JSON.stringify(body) },
      options?.signal
    );
  }

  async getOrder(
    id: string,
    options?: { signal?: AbortSignal }
  ): Promise<PaycrestOrder> {
    this.requireApiKey("getOrder");
    return this.request<PaycrestOrder>(
      `/v2/sender/orders/${encodeURIComponent(id)}`,
      { method: "GET" },
      options?.signal
    );
  }

  async listOrders(
    filter?: Record<string, string | number>,
    options?: { signal?: AbortSignal }
  ): Promise<{
    orders: PaycrestOrder[];
    [key: string]: unknown;
  }> {
    this.requireApiKey("listOrders");
    let path = "/v2/sender/orders";
    if (filter && Object.keys(filter).length > 0) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(filter)) params.set(k, String(v));
      path += `?${params.toString()}`;
    }
    return this.request<{ orders: PaycrestOrder[] }>(
      path,
      { method: "GET" },
      options?.signal
    );
  }

  /**
   * Look up an order by its on-chain gateway_id. Hits
   * `GET /v2/orders/{chain_id}/{gateway_id}` (the
   * `GetProviderOrderStatus` endpoint), which is the only public
   * endpoint that indexes by gateway_id.
   *
   * Public endpoint — no API key required. Returns a smaller status
   * shape than the full `PaycrestOrder`.
   *
   * `chainId` is the aggregator's fictional int64 for the network —
   * for Starknet mainnet it's `STARKNET_MAINNET_CHAIN_ID` from
   * `presets.ts`. Stored as `bigint` because the value exceeds
   * `Number.MAX_SAFE_INTEGER`.
   */
  async getProviderOrderStatus(
    chainId: bigint | number | string,
    gatewayId: string,
    options?: { signal?: AbortSignal }
  ): Promise<PaycrestProviderOrderStatus> {
    if (!gatewayId) {
      throw new Error("Paycrest.getProviderOrderStatus: gatewayId is required");
    }
    return this.request<PaycrestProviderOrderStatus>(
      `/v2/orders/${encodeURIComponent(String(chainId))}/${encodeURIComponent(gatewayId)}`,
      { method: "GET" },
      options?.signal
    );
  }

  private requireApiKey(method: string): void {
    if (!this.apiKey) {
      throw new Error(
        `Paycrest.${method} requires an API key — pass apiKey to the Paycrest constructor or via SDKConfig.paycrest.apiKey.`
      );
    }
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    callerSignal?: AbortSignal
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // Forward an external abort onto our internal controller so the
    // in-flight fetch is cancelled immediately. Without this, callers
    // who passed `signal` to a higher-level wait method would have to
    // wait for `timeoutMs` to elapse before the HTTP request gives up.
    let onCallerAbort: (() => void) | undefined;
    if (callerSignal) {
      if (callerSignal.aborted) {
        controller.abort();
      } else {
        onCallerAbort = () => controller.abort();
        callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (this.apiKey) headers["API-Key"] = this.apiKey;
    if (init.headers)
      Object.assign(headers, init.headers as Record<string, string>);

    try {
      const res = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });

      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        if (!res.ok) {
          throw new Error(
            `Paycrest API ${init.method ?? "GET"} ${path} failed: ${res.status} ${res.statusText}`
          );
        }
        throw new Error(`Paycrest API returned non-JSON response for ${path}`);
      }

      if (!res.ok) {
        const message =
          extractErrorMessage(parsed) ?? `${res.status} ${res.statusText}`;
        throw new Error(
          `Paycrest API ${init.method ?? "GET"} ${path} failed: ${message}`
        );
      }

      const envelope = parsed as Partial<PaycrestEnvelope<T>>;
      if (envelope && "data" in envelope) {
        return envelope.data as T;
      }
      // Some endpoints (e.g. raw key) may return a value directly.
      return parsed as T;
    } catch (error) {
      const name = errorName(error);
      if (name === "AbortError") {
        if (callerSignal?.aborted) {
          throw new Error(
            `Paycrest API ${init.method ?? "GET"} ${path} aborted by caller signal`
          );
        }
        throw new Error(
          `Paycrest API ${init.method ?? "GET"} ${path} timed out after ${this.timeoutMs}ms`
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (callerSignal && onCallerAbort) {
        callerSignal.removeEventListener("abort", onCallerAbort);
      }
    }
  }
}

function extractErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  for (const key of ["message", "error", "details"]) {
    const entry = v[key];
    if (typeof entry === "string" && entry.length > 0) return entry;
  }
  if (typeof v["data"] === "object" && v["data"] !== null) {
    return extractErrorMessage(v["data"]);
  }
  return null;
}

function errorName(error: unknown): string {
  if (error && typeof error === "object" && "name" in error) {
    const n = (error as { name?: unknown }).name;
    return typeof n === "string" ? n : "";
  }
  return "";
}
