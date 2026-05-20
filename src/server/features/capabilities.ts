import { config, isGithubOAuthConfigured } from "../config.js";
import { getGithubAuthFromContext } from "../state/requestContext.js";
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

export function getSetupStatus(callbackUrl?: string): SetupStatus {
  const github = getGithubAuthFromContext();
  const githubAuthMissing = githubOAuthMissing();
  if (!github) githubAuthMissing.push("Connect your GitHub account");

  const projectEditingMissing = [...githubAuthMissing];
  if (!config.openaiApiKey) projectEditingMissing.unshift("OPENAI_API_KEY");

  const githubOAuthConfigured = isGithubOAuthConfigured();
  const githubConnected = Boolean(github);

  return {
    openaiConfigured: Boolean(config.openaiApiKey),
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
      githubAuth: {
        ready: githubOAuthConfigured && githubConnected,
        missing: unique(githubAuthMissing)
      },
      projectEditing: {
        ready: Boolean(config.openaiApiKey) && githubOAuthConfigured && githubConnected,
        missing: unique(projectEditingMissing)
      }
    }
  };
}
