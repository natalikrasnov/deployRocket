import { config } from "../config.js";
import { AppError, setupHelp } from "../lib/errors.js";
import { createId, nowIso } from "../lib/id.js";
import type { CustomerAccountState } from "../state/authStore.js";
import type { BillingPlan } from "../../shared/types.js";

export const deployRocketBillingPlan: BillingPlan = {
  currency: "USD",
  totalCents: 500,
  openaiApiBudgetCents: 400,
  platformCommissionCents: 100
};

export interface OpenAIBillingIntent {
  id: string;
  mode: "mock" | "live";
  status: "mock_ready" | "requires_action" | "active";
  plan: BillingPlan;
  createdAt: string;
}

export function getBillingPlan() {
  return deployRocketBillingPlan;
}

export async function createMockOpenAIBillingIntent(account: CustomerAccountState | null) {
  const platformFallbackReady = config.allowPlatformOpenAIFallback && Boolean(config.openaiApiKey);
  if (!account?.openai?.apiKey && !platformFallbackReady) {
    throw new AppError("Save your OpenAI API key before activating billing.", {
      statusCode: 400,
      code: "OPENAI_CLIENT_NOT_CONNECTED",
      setupInstructions: setupHelp.openaiCustomer
    });
  }

  return {
    id: createId("billing_intent"),
    mode: "mock",
    status: "mock_ready",
    plan: deployRocketBillingPlan,
    createdAt: nowIso()
  } satisfies OpenAIBillingIntent;
}

export function billingStateFromIntent(intent: OpenAIBillingIntent) {
  return {
    status: intent.mode === "mock" ? "mock_active" : "active",
    mode: intent.mode,
    intentId: intent.id,
    activatedAt: intent.createdAt,
    plan: intent.plan
  } satisfies CustomerAccountState["billing"];
}

export async function createLiveOpenAIBillingIntent(_account: CustomerAccountState) {
  if (!config.openaiBillingApiBase || !config.platformCommissionAccountId) {
    throw new AppError("OpenAI API billing integration is not configured yet.", {
      statusCode: 501,
      code: "OPENAI_BILLING_NOT_IMPLEMENTED",
      setupInstructions: setupHelp.openaiBilling
    });
  }

  throw new AppError("OpenAI API billing integration scaffold is ready, but live billing is disabled.", {
    statusCode: 501,
    code: "OPENAI_BILLING_MOCK_ONLY",
    setupInstructions: setupHelp.openaiBilling
  });
}
