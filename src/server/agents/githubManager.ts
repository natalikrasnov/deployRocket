import { config, isGithubOAuthConfigured } from "../config.js";
import { AppError, setupHelp } from "../lib/errors.js";
import { slugify, nowIso } from "../lib/id.js";
import { authStore, type GitHubAuthState } from "../state/authStore.js";
import type { GeneratedFile, Project, SetupStatus } from "../../shared/types.js";

interface GitHubUserResponse {
  id: number;
  login: string;
  html_url: string;
  avatar_url?: string;
}

interface GitHubRepoResponse {
  name: string;
  full_name: string;
  html_url: string;
  owner: {
    login: string;
  };
  default_branch: string;
}

interface GitRefResponse {
  object: {
    sha: string;
  };
}

interface GitCommitResponse {
  sha: string;
  tree: {
    sha: string;
  };
}

interface GitTreeResponse {
  sha: string;
}

interface WorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_sha: string;
  created_at: string;
  updated_at: string;
}

interface WorkflowRunsResponse {
  workflow_runs: WorkflowRun[];
}

interface PagesResponse {
  html_url?: string;
  status?: string;
  build_type?: string;
}

interface ApiOptions {
  method?: string;
  body?: unknown;
  token?: string;
  signal?: AbortSignal;
  allow404?: boolean;
  allow409?: boolean;
}

const apiBase = "https://api.github.com";

export class GitHubManager {
  getAuthorizationUrl(state: string) {
    if (!isGithubOAuthConfigured()) {
      throw new AppError("GitHub OAuth is not configured.", {
        statusCode: 500,
        code: "GITHUB_OAUTH_NOT_CONFIGURED",
        setupInstructions: setupHelp.githubOAuth
      });
    }

    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", config.githubClientId);
    url.searchParams.set("redirect_uri", config.githubCallbackUrl);
    url.searchParams.set("scope", "repo workflow user:email");
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeCode(sessionId: string, code: string, signal?: AbortSignal) {
    if (!isGithubOAuthConfigured()) {
      throw new AppError("GitHub OAuth is not configured.", {
        statusCode: 500,
        code: "GITHUB_OAUTH_NOT_CONFIGURED",
        setupInstructions: setupHelp.githubOAuth
      });
    }

    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        client_id: config.githubClientId,
        client_secret: config.githubClientSecret,
        code,
        redirect_uri: config.githubCallbackUrl
      }),
      signal
    });

    const payload = (await response.json()) as {
      access_token?: string;
      token_type?: string;
      scope?: string;
      error?: string;
      error_description?: string;
    };

    if (!response.ok || !payload.access_token) {
      throw new AppError("GitHub OAuth token exchange failed.", {
        statusCode: 502,
        code: "GITHUB_OAUTH_EXCHANGE_FAILED",
        details: payload.error_description ?? payload.error
      });
    }

    const user = await this.fetchUser(payload.access_token, signal);
    const auth: GitHubAuthState = {
      accessToken: payload.access_token,
      tokenType: payload.token_type ?? "bearer",
      scope: payload.scope ?? "",
      connectedAt: nowIso(),
      user: {
        id: user.id,
        login: user.login,
        htmlUrl: user.html_url,
        avatarUrl: user.avatar_url
      }
    };

    await authStore.setGithub(sessionId, auth);
    return auth;
  }

  async getSetupStatus(sessionId: string): Promise<SetupStatus> {
    const github = await authStore.getGithub(sessionId);
    const missing: string[] = [];
    if (!config.openaiApiKey) missing.push("OPENAI_API_KEY");
    if (!config.githubClientId) missing.push("GITHUB_CLIENT_ID");
    if (!config.githubClientSecret) missing.push("GITHUB_CLIENT_SECRET");
    if (!config.githubCallbackUrl) missing.push("GITHUB_CALLBACK_URL");
    if (!github) missing.push("Connect your GitHub account");

    return {
      openaiConfigured: Boolean(config.openaiApiKey),
      githubOAuthConfigured: isGithubOAuthConfigured(),
      githubConnected: Boolean(github),
      githubUser: github
        ? {
            login: github.user.login,
            htmlUrl: github.user.htmlUrl,
            avatarUrl: github.user.avatarUrl
          }
        : undefined,
      callbackUrl: config.githubCallbackUrl,
      defaultBranch: config.githubDefaultBranch,
      missing: [...new Set(missing)]
    };
  }

  async disconnect(sessionId: string) {
    await authStore.clearGithub(sessionId);
  }

  async findSessionIdForUser(login: string) {
    return authStore.findSessionIdForUser(login);
  }

  async ensureAuthenticated(sessionId: string, signal?: AbortSignal) {
    const github = await authStore.getGithub(sessionId);

    if (!github) {
      throw new AppError("GitHub is not connected for this browser session.", {
        statusCode: 401,
        code: "GITHUB_NOT_CONNECTED",
        setupInstructions: setupHelp.githubToken
      });
    }

    try {
      await this.fetchUser(github.accessToken, signal);
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 401) {
        throw new AppError("GitHub token is invalid or expired.", {
          statusCode: 401,
          code: "GITHUB_TOKEN_INVALID",
          setupInstructions: setupHelp.githubTokenInvalid,
          details: error.details
        });
      }
      throw error;
    }

    return github;
  }

  async ensureRepository(
    project: Project,
    repositoryNameSuggestion: string,
    sessionId: string,
    signal?: AbortSignal
  ) {
    const github = await this.ensureAuthenticated(sessionId, signal);

    if (project.githubOwner && project.githubRepo && project.githubRepoUrl) {
      return {
        owner: project.githubOwner,
        repo: project.githubRepo,
        url: project.githubRepoUrl,
        branch: project.githubDefaultBranch ?? config.githubDefaultBranch
      };
    }

    const baseName = slugify(repositoryNameSuggestion || project.name, "deployrocket-project");
    const description = project.summary.slice(0, 240) || "Generated by deployRocket";

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const name = attempt === 0 ? baseName : `${baseName}-${attempt + 1}`;

      try {
        const repo = await this.api<GitHubRepoResponse>("/user/repos", {
          method: "POST",
          token: github.accessToken,
          body: {
            name,
            description,
            private: false,
            auto_init: true,
            has_issues: true,
            has_projects: false,
            has_wiki: false
          },
          signal
        });

        return {
          owner: repo.owner.login,
          repo: repo.name,
          url: repo.html_url,
          branch: repo.default_branch || config.githubDefaultBranch
        };
      } catch (error) {
        if (error instanceof AppError && error.statusCode === 422) continue;
        throw error;
      }
    }

    throw new AppError("Could not create a unique GitHub repository name.", {
      statusCode: 409,
      code: "GITHUB_DUPLICATE_REPOSITORY_NAME",
      details: `Base repository name: ${baseName}`
    });
  }

  async commitFiles(params: {
    owner: string;
    repo: string;
    branch: string;
    files: GeneratedFile[];
    previousPaths: string[];
    message: string;
    sessionId: string;
    signal?: AbortSignal;
  }) {
    const github = await this.ensureAuthenticated(params.sessionId, params.signal);
    const token = github.accessToken;
    const branch = params.branch || config.githubDefaultBranch;
    const ref = await this.getBranchRef(params.owner, params.repo, branch, token, params.signal);
    const parentCommit = await this.api<GitCommitResponse>(
      `/repos/${params.owner}/${params.repo}/git/commits/${ref.object.sha}`,
      { token, signal: params.signal }
    );

    const nextPaths = new Set(params.files.map((file) => file.path));
    const removedPaths = params.previousPaths.filter((filePath) => !nextPaths.has(filePath));
    const treeEntries = [
      ...params.files.map((file) => ({
        path: file.path,
        mode: "100644",
        type: "blob",
        content: file.content
      })),
      ...removedPaths.map((filePath) => ({
        path: filePath,
        mode: "100644",
        type: "blob",
        sha: null
      }))
    ];

    const tree = await this.api<GitTreeResponse>(`/repos/${params.owner}/${params.repo}/git/trees`, {
      method: "POST",
      token,
      body: {
        base_tree: parentCommit.tree.sha,
        tree: treeEntries
      },
      signal: params.signal
    });

    const commit = await this.api<GitCommitResponse>(
      `/repos/${params.owner}/${params.repo}/git/commits`,
      {
        method: "POST",
        token,
        body: {
          message: params.message,
          tree: tree.sha,
          parents: [parentCommit.sha]
        },
        signal: params.signal
      }
    );

    await this.api(`/repos/${params.owner}/${params.repo}/git/refs/heads/${branch}`, {
      method: "PATCH",
      token,
      body: {
        sha: commit.sha,
        force: false
      },
      signal: params.signal
    });

    return commit.sha;
  }

  async enablePages(owner: string, repo: string, sessionId: string, signal?: AbortSignal) {
    const github = await this.ensureAuthenticated(sessionId, signal);
    const token = github.accessToken;

    const existing = await this.api<PagesResponse | null>(`/repos/${owner}/${repo}/pages`, {
      token,
      signal,
      allow404: true
    });

    if (existing) {
      try {
        await this.api(`/repos/${owner}/${repo}/pages`, {
          method: "PUT",
          token,
          body: { build_type: "workflow" },
          signal,
          allow409: true
        });
      } catch (error) {
        if (!(error instanceof AppError && [409, 422].includes(error.statusCode))) throw error;
      }
      return existing;
    }

    return this.api<PagesResponse>(`/repos/${owner}/${repo}/pages`, {
      method: "POST",
      token,
      body: { build_type: "workflow" },
      signal,
      allow409: true
    });
  }

  async dispatchPagesWorkflow(
    owner: string,
    repo: string,
    branch: string,
    sessionId: string,
    signal?: AbortSignal
  ) {
    const github = await this.ensureAuthenticated(sessionId, signal);
    const result = await this.api<null | Record<string, never>>(
      `/repos/${owner}/${repo}/actions/workflows/pages.yml/dispatches`,
      {
        method: "POST",
        token: github.accessToken,
        body: { ref: branch },
        signal,
        allow404: true
      }
    );

    return result !== null;
  }

  async getLatestPagesRun(
    owner: string,
    repo: string,
    branch: string,
    sessionId: string,
    signal?: AbortSignal
  ) {
    const github = await this.ensureAuthenticated(sessionId, signal);
    const encodedBranch = encodeURIComponent(branch);
    const workflowRuns = await this.api<WorkflowRunsResponse | null>(
      `/repos/${owner}/${repo}/actions/workflows/pages.yml/runs?branch=${encodedBranch}&per_page=10`,
      {
        token: github.accessToken,
        signal,
        allow404: true
      }
    );

    return workflowRuns?.workflow_runs?.[0] ?? null;
  }

  async getPages(owner: string, repo: string, sessionId: string, signal?: AbortSignal) {
    const github = await this.ensureAuthenticated(sessionId, signal);
    return this.api<PagesResponse | null>(`/repos/${owner}/${repo}/pages`, {
      token: github.accessToken,
      signal,
      allow404: true
    });
  }

  private async getBranchRef(
    owner: string,
    repo: string,
    branch: string,
    token: string,
    signal?: AbortSignal
  ) {
    let lastError: unknown;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await this.api<GitRefResponse>(`/repos/${owner}/${repo}/git/ref/heads/${branch}`, {
          token,
          signal
        });
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
    }

    throw lastError;
  }

  private async fetchUser(token: string, signal?: AbortSignal) {
    return this.api<GitHubUserResponse>("/user", { token, signal });
  }

  private async api<T>(path: string, options: ApiOptions = {}): Promise<T> {
    const response = await fetch(`${apiBase}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.body ? { "Content-Type": "application/json" } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: options.signal
    });

    if (response.status === 404 && options.allow404) return null as T;
    if (response.status === 409 && options.allow409) return null as T;
    if (response.status === 204) return null as T;

    const text = await response.text();
    const payload = text ? safeJson(text) : null;

    if (!response.ok) {
      throw new AppError(readGithubMessage(payload, response.statusText), {
        statusCode: response.status,
        code: `GITHUB_${response.status}`,
        details: text
      });
    }

    return payload as T;
  }
}

function safeJson(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function readGithubMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object" && "message" in payload) {
    return String((payload as { message: unknown }).message);
  }
  return fallback || "GitHub API request failed.";
}

export const githubManager = new GitHubManager();
