import { AsyncLocalStorage } from "node:async_hooks";
import { AppError, setupHelp } from "../lib/errors.js";
import type { CustomerAccountState, GitHubAuthState } from "./authStore.js";

export interface RequestContext {
  github: GitHubAuthState | null;
  account: CustomerAccountState | null;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getGithubAuthFromContext() {
  return requestContext.getStore()?.github ?? null;
}

export function getCustomerAccountFromContext() {
  return requestContext.getStore()?.account ?? null;
}

export function setGithubAuthInContext(github: GitHubAuthState | null) {
  const store = requestContext.getStore();
  if (store) store.github = github;
}

export function setCustomerAccountInContext(account: CustomerAccountState | null) {
  const store = requestContext.getStore();
  if (store) store.account = account;
}

export function requireGithubAuthFromContext() {
  const github = getGithubAuthFromContext();
  if (!github) {
    throw new AppError("GitHub is not connected for this browser session.", {
      statusCode: 401,
      code: "GITHUB_NOT_CONNECTED",
      setupInstructions: setupHelp.githubToken
    });
  }
  return github;
}
