import type { BillingPlan } from "../../shared/types.js";

export interface GitHubAuthState {
  accessToken: string;
  tokenType: string;
  scope: string;
  connectedAt: string;
  user: {
    login: string;
    id: number;
    htmlUrl: string;
    avatarUrl?: string;
  };
}

export interface CustomerAccountState {
  openai?: {
    apiKey: string;
    clientId?: string;
    keyFingerprint: string;
    connectedAt: string;
  };
  billing?: {
    status: "mock_active" | "active";
    mode: "mock" | "live";
    intentId: string;
    activatedAt: string;
    plan: BillingPlan;
  };
}
