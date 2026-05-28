import { config, isGithubOAuthConfigured } from "../config.js";
import { getBillingPlan } from "../billing/openaiBilling.js";
import { getCustomerAccountFromContext, getGithubAuthFromContext } from "../state/requestContext.js";
import type { SetupStatus } from "../../shared/types.js";

function unique(items: string[]) {
  return [...new Set(items)];
}

function githubOAuthMissing() {
  const missing: string[] = [];
  if (!config.githubClientId) missing.push("GITHUB_CLIENT_ID");
  if (!config.githubClientSecret) missing.push("GITHUB_CLIENT_SECRET");
  if (!config.githubCallbackUrl) missing.push("GITHUB_CALLBACK_URL");
  return missing;
}

function hasGithubScope(scopeHeader: string | undefined, requiredScope: string) {
  return (scopeHeader ?? "")
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean)
    .includes(requiredScope);
}

export function getSetupStatus(callbackUrl?: string): SetupStatus {
  const github = getGithubAuthFromContext();
  const account = getCustomerAccountFromContext();
  const githubAuthMissing = githubOAuthMissing();
  if (!github) githubAuthMissing.push("Connect your GitHub account");
  if (github && !hasGithubScope(github.scope, "workflow")) {
    githubAuthMissing.push("Reconnect GitHub with workflow permission");
  }

  const userOpenAIConnected = Boolean(account?.openai?.apiKey);
  const platformOpenAIReady = config.allowPlatformOpenAIFallback && Boolean(config.openaiApiKey);
  const openaiReady = userOpenAIConnected || platformOpenAIReady;
  const openaiMissing = openaiReady ? [] : ["Save your OpenAI API key in Settings"];

  const accountBillingReady = account?.billing?.status === "mock_active" || account?.billing?.status === "active";
  const billingReady = accountBillingReady || openaiReady;
  const billingMissing: string[] = [];

  const projectEditingMissing = [...openaiMissing, ...githubAuthMissing];

  const githubOAuthConfigured = isGithubOAuthConfigured();
  const githubConnected = Boolean(github);
  const billingPlan = getBillingPlan();

  return {
    openaiConfigured: openaiReady,
    openaiConnection: {
      connected: userOpenAIConnected,
      source: userOpenAIConnected ? "user" : platformOpenAIReady ? "platform" : "missing",
      connectedAt: account?.openai?.connectedAt,
      keyFingerprint: account?.openai?.keyFingerprint
    },
    billing: {
      connected: billingReady,
      mode: account?.billing?.mode ?? "mock",
      status: account?.billing?.status ?? (openaiReady ? "mock_active" : "inactive"),
      plan: account?.billing?.plan ?? billingPlan,
      activatedAt: account?.billing?.activatedAt,
      lastIntentId: account?.billing?.intentId,
      commissionRecipientConfigured: Boolean(config.platformCommissionAccountId)
    },
    githubOAuthConfigured,
    githubConnected,
    githubUser: github
      ? {
          login: github.user.login,
          htmlUrl: github.user.htmlUrl,
          avatarUrl: github.user.avatarUrl
        }
      : undefined,
    callbackUrl: callbackUrl ?? config.githubCallbackUrl,
    defaultBranch: config.githubDefaultBranch,
    missing: unique(projectEditingMissing),
    features: {
      openaiClient: {
        ready: openaiReady,
        missing: unique(openaiMissing)
      },
      githubAuth: {
        ready: githubOAuthConfigured && githubConnected,
        missing: unique(githubAuthMissing)
      },
      billing: {
        ready: billingReady,
        missing: unique(billingMissing)
      },
      projectEditing: {
        ready: openaiReady && githubOAuthConfigured && githubConnected,
        missing: unique(projectEditingMissing)
      }
    }
  };
}
