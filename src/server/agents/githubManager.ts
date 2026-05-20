import { config, isGithubOAuthConfigured } from "../config.js";
import { AppError, setupHelp } from "../lib/errors.js";
import { slugify, nowIso } from "../lib/id.js";
import { getGithubAuthFromContext, requireGithubAuthFromContext } from "../state/requestContext.js";
import type { GitHubAuthState } from "../state/authStore.js";
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
  topics?: string[];
  owner: {
    login: string;
  };
  default_branch: string;
}

interface GitHubSearchResponse {
  items: GitHubRepoResponse[];
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

interface GitHubContentResponse {
  content?: string;
  encoding?: string;
  sha: string;
  type: string;
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
  getAuthorizationUrl(state: string, callbackUrl: string) {
    if (!isGithubOAuthConfigured()) {
      throw new AppError("GitHub OAuth is not configured.", {
        statusCode: 500,
        code: "GITHUB_OAUTH_NOT_CONFIGURED",
        setupInstructions: setupHelp.githubOAuth
      });
    }

    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", config.githubClientId);
    url.searchParams.set("redirect_uri", callbackUrl);
    url.searchParams.set("scope", "repo workflow user:email");
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeCode(_sessionId: string, code: string, callbackUrl: string, signal?: AbortSignal) {
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
        redirect_uri: callbackUrl
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

    return auth;
  }

  async getSetupStatus(_sessionId: string, callbackUrl?: string): Promise<SetupStatus> {
    const github = getGithubAuthFromContext();
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
      callbackUrl: callbackUrl ?? config.githubCallbackUrl,
      defaultBranch: config.githubDefaultBranch,
      missing: [...new Set(missing)]
    };
  }

  async disconnect(_sessionId: string) {
    return true;
  }

  async findSessionIdForUser(_login: string) {
    return null;
  }

  async ensureAuthenticated(_sessionId: string, signal?: AbortSignal) {
    const github = requireGithubAuthFromContext();

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

  async createDeployRocketRepository(nameSuggestion: string, description: string, signal?: AbortSignal) {
    const github = await this.ensureAuthenticated("", signal);
    const baseName = slugify(nameSuggestion, "deployrocket-project");

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const name = attempt === 0 ? baseName : `${baseName}-${attempt + 1}`;

      try {
        const repo = await this.api<GitHubRepoResponse>("/user/repos", {
          method: "POST",
          token: github.accessToken,
          body: {
            name,
            description: description.slice(0, 240) || "Generated by deployRocket",
            private: false,
            auto_init: true,
            has_issues: true,
            has_projects: false,
            has_wiki: false
          },
          signal
        });
        await this.setTopics(repo.owner.login, repo.name, [config.githubProjectTopic], "", signal);
        return this.toRepositoryRef(repo);
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

  async renameDeployRocketRepository(
    project: Project,
    nameSuggestion: string,
    sessionId: string,
    signal?: AbortSignal
  ) {
    if (!project.githubOwner || !project.githubRepo) return null;
    const github = await this.ensureAuthenticated(sessionId, signal);
    const baseName = slugify(nameSuggestion || project.name, project.githubRepo);

    if (baseName === project.githubRepo) {
      return {
        owner: project.githubOwner,
        repo: project.githubRepo,
        url: project.githubRepoUrl ?? `https://github.com/${project.githubOwner}/${project.githubRepo}`,
        branch: project.githubDefaultBranch ?? config.githubDefaultBranch
      };
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const name = attempt === 0 ? baseName : `${baseName}-${attempt + 1}`;

      try {
        const repo = await this.api<GitHubRepoResponse>(
          `/repos/${project.githubOwner}/${project.githubRepo}`,
          {
            method: "PATCH",
            token: github.accessToken,
            body: {
              name,
              description: project.summary.slice(0, 240) || "Generated by deployRocket"
            },
            signal
          }
        );
        await this.setTopics(repo.owner.login, repo.name, [config.githubProjectTopic], sessionId, signal);
        return this.toRepositoryRef(repo);
      } catch (error) {
        if (error instanceof AppError && error.statusCode === 422) continue;
        throw error;
      }
    }

    throw new AppError("Could not create a unique GitHub repository name for rename.", {
      statusCode: 409,
      code: "GITHUB_DUPLICATE_REPOSITORY_NAME",
      details: `Base repository name: ${baseName}`
    });
  }

  async listDeployRocketRepositories(signal?: AbortSignal) {
    const github = await this.ensureAuthenticated("", signal);
    const owner = github.user.login;
    const query = encodeURIComponent(`user:${owner} topic:${config.githubProjectTopic}`);
    const result = await this.api<GitHubSearchResponse>(
      `/search/repositories?q=${query}&sort=updated&order=desc&per_page=100`,
      { token: github.accessToken, signal }
    );
    return result.items.map((repo) => this.toRepositoryRef(repo));
  }

  async ensureRepository(
    project: Project,
    repositoryNameSuggestion: string,
    sessionId: string,
    signal?: AbortSignal
  ) {
    await this.ensureAuthenticated(sessionId, signal);

    if (project.githubOwner && project.githubRepo && project.githubRepoUrl) {
      return {
        owner: project.githubOwner,
        repo: project.githubRepo,
        url: project.githubRepoUrl,
        branch: project.githubDefaultBranch ?? config.githubDefaultBranch
      };
    }

    return this.createDeployRocketRepository(
      repositoryNameSuggestion || project.name,
      project.summary,
      signal
    );
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

  async getTextFile(
    owner: string,
    repo: string,
    path: string,
    branch: string,
    signal?: AbortSignal
  ) {
    const github = await this.ensureAuthenticated("", signal);
    const encodedPath = encodePath(path);
    const encodedRef = encodeURIComponent(branch);
    const response = await this.api<GitHubContentResponse | null>(
      `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodedRef}`,
      { token: github.accessToken, signal, allow404: true }
    );

    if (!response || response.type !== "file" || !response.content) return null;
    return {
      content: Buffer.from(response.content.replace(/\n/g, ""), "base64").toString("utf8"),
      sha: response.sha
    };
  }

  async putTextFile(params: {
    owner: string;
    repo: string;
    path: string;
    branch: string;
    baseBranch: string;
    content: string;
    message: string;
    signal?: AbortSignal;
  }) {
    const github = await this.ensureAuthenticated("", params.signal);
    await this.ensureBranch(
      params.owner,
      params.repo,
      params.branch,
      params.baseBranch,
      github.accessToken,
      params.signal
    );
    const existing = await this.getTextFile(
      params.owner,
      params.repo,
      params.path,
      params.branch,
      params.signal
    );
    await this.api(`/repos/${params.owner}/${params.repo}/contents/${encodePath(params.path)}`, {
      method: "PUT",
      token: github.accessToken,
      body: {
        message: params.message,
        content: Buffer.from(params.content, "utf8").toString("base64"),
        branch: params.branch,
        sha: existing?.sha
      },
      signal: params.signal
    });
  }

  async readTextFiles(
    owner: string,
    repo: string,
    branch: string,
    paths: string[],
    signal?: AbortSignal
  ): Promise<GeneratedFile[]> {
    const files: GeneratedFile[] = [];
    for (const filePath of paths) {
      const result = await this.getTextFile(owner, repo, filePath, branch, signal);
      if (result) files.push({ path: filePath, content: result.content });
    }
    return files;
  }

  private async setTopics(
    owner: string,
    repo: string,
    topics: string[],
    sessionId: string,
    signal?: AbortSignal
  ) {
    const github = await this.ensureAuthenticated(sessionId, signal);
    await this.api(`/repos/${owner}/${repo}/topics`, {
      method: "PUT",
      token: github.accessToken,
      body: { names: topics },
      signal
    });
  }

  private async ensureBranch(
    owner: string,
    repo: string,
    branch: string,
    baseBranch: string,
    token: string,
    signal?: AbortSignal
  ) {
    const existing = await this.api<GitRefResponse | null>(
      `/repos/${owner}/${repo}/git/ref/heads/${branch}`,
      { token, signal, allow404: true }
    );
    if (existing) return existing;

    const base = await this.getBranchRef(owner, repo, baseBranch || config.githubDefaultBranch, token, signal);
    return this.api<GitRefResponse>(`/repos/${owner}/${repo}/git/refs`, {
      method: "POST",
      token,
      body: {
        ref: `refs/heads/${branch}`,
        sha: base.object.sha
      },
      signal
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

  private toRepositoryRef(repo: GitHubRepoResponse) {
    return {
      owner: repo.owner.login,
      repo: repo.name,
      url: repo.html_url,
      branch: repo.default_branch || config.githubDefaultBranch
    };
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

function encodePath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
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
