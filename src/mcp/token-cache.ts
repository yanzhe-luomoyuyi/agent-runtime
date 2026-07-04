/**
 * Shared auth-token cache — the second half of the "shared MCP base SDK".
 *
 * Every server otherwise re-implements "fetch a token, cache it, refresh before
 * it expires". Here it lives once and is *shared by reference*: hand the same
 * `TokenCache` to N `McpClient`s and they collectively hit the auth endpoint
 * once (until expiry), instead of N times. The `fetches` counter makes that
 * convergence observable (and testable).
 */

export interface TokenResponse {
  token: string;
  /** Absolute expiry in epoch milliseconds. */
  expiresAtMs: number;
}

export type TokenFetcher = () => Promise<TokenResponse> | TokenResponse;

export class TokenCache {
  private cached?: TokenResponse;
  /** How many times the underlying auth endpoint was actually hit. */
  fetches = 0;

  constructor(
    private readonly fetcher: TokenFetcher,
    /** Refresh this many ms before the real expiry, to avoid using a token mid-flight. */
    private readonly skewMs = 1_000,
    private readonly clock: () => number = Date.now,
  ) {}

  async get(): Promise<string> {
    const current = this.cached;
    if (current && this.clock() < current.expiresAtMs - this.skewMs) {
      return current.token;
    }
    this.fetches++;
    this.cached = await this.fetcher();
    return this.cached.token;
  }
}
