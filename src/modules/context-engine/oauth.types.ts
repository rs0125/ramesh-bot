/** Encrypted credential payloads stay behind the resolver and never enter graph state or prompts. */
export const CONTEXT_OAUTH_SCOPES = ['crm:read', 'warehouses:read', 'knowledge:read'] as const;
export type ContextOAuthScope = (typeof CONTEXT_OAUTH_SCOPES)[number];
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAtMs: number;
  scopes: ContextOAuthScope[];
}
export interface StoredEmployeeGrant extends OAuthTokens {
  employeeId: number;
  phoneE164: string;
  email: string;
  clientId: string;
  resource: string;
  grantExpiresAtMs: number;
}
export interface OAuthEnrollment {
  employeeId: number;
  phoneE164: string;
  email: string;
  clientId: string;
  resource: string;
  redirectUri: string;
  verifier: string;
  state: string;
  scopes: ContextOAuthScope[];
  startedAtMs: number;
}
export type GrantState = 'ACTIVE' | 'REFRESHING' | 'REVOKE_PENDING' | 'REVOKED';
export interface StoredGrant {
  id: string;
  employeeId: number;
  version: number;
  state: GrantState;
  operation: string | null;
  operationExpiresAtMs: number | null;
  value: StoredEmployeeGrant | null;
}
export interface ContextOAuthTransport {
  register(
    redirectUri: string,
    scopes: readonly ContextOAuthScope[],
    signal: AbortSignal,
  ): Promise<string>;
  exchange(enrollment: OAuthEnrollment, code: string, signal: AbortSignal): Promise<OAuthTokens>;
  refresh(grant: StoredEmployeeGrant, signal: AbortSignal): Promise<OAuthTokens>;
  revoke(grant: StoredEmployeeGrant, signal: AbortSignal): Promise<void>;
}
