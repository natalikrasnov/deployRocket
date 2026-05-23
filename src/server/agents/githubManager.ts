import { config, isGithubOAuthConfigured } from "../config.js";
import { AppError, setupHelp } from "../lib/errors.js";
import { slugify, nowIso } from "../lib/id.js";
import { requireGithubAuthFromContext } from "../state/requestContext.js";
import type { GitHubAuthState } from "../state/authStore.js";
import type { GeneratedFile, Project } from "../../shared/types.js";

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
  homepage?: string | null;
  has_pages?: boolean;
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

interface GitTreeListingResponse {
  tree?: Array<{
    path?: string;
    type?: string;
    sha?: string;
  }>;
  truncated?: boolean;
}

interface GitHubContentResponse {
  content?: string;
  encoding?: string;
  sha: string;
  type: string;
}

interface GitHubPagesResponse {
  html_url?: string;
  status?: string;
  source?: {
    branch?: string;
    path?: string;
  };
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
const defaultWriteConflictRetries = 4;
const defaultRefConflictRetries = 3;

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
    url.searchParams.set("scope", "repo user:email");
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
    let lastError: unknown;
    for (let attempt = 0; attempt < defaultRefConflictRetries; attempt += 1) {
      try {
        return await this.commitFilesOnce(params);
      } catch (error) {
        lastError = error;
        if (!isRetryableRefUpdateConflict(error) || attempt === defaultRefConflictRetries - 1) {
          throw error;
        }
        await delay(conflictBackoffMs(attempt), params.signal);
      }
    }

    throw lastError;
  }

  private async commitFilesOnce(params: {
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
    const existingBlobPaths = await this.listTreeBlobPaths(
      params.owner,
      params.repo,
      parentCommit.tree.sha,
      token,
      params.signal
    );

    const nextPaths = new Set(params.files.map((file) => file.path));
    const removedPaths = params.previousPaths.filter((filePath) => {
      return !nextPaths.has(filePath) && existingBlobPaths.has(filePath);
    });
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
    retryOnConflict?: boolean;
    maxConflictRetries?: number;
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

    const shouldRetry = params.retryOnConflict !== false;
    const maxAttempts = shouldRetry
      ? Math.max(1, params.maxConflictRetries ?? defaultWriteConflictRetries)
      : 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) await delay(conflictBackoffMs(attempt - 1), params.signal);

      const existing = await this.getTextFile(
        params.owner,
        params.repo,
        params.path,
        params.branch,
        params.signal
      );

      try {
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
        return;
      } catch (error) {
        lastError = error;
        if (!isGitHubShaConflict(error) || attempt === maxAttempts - 1) throw error;
      }
    }

    throw lastError;
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

  async getGitHubPages(owner: string, repo: string, sessionId: string, signal?: AbortSignal) {
    const github = await this.ensureAuthenticated(sessionId, signal);
    const pages = await this.getPagesSite(owner, repo, github.accessToken, signal);
    if (!pages) return null;

    return {
      url: normalizeUrl(pages.html_url) ?? defaultGitHubPagesUrl(owner, repo),
      status: pages.status ?? "unknown"
    };
  }

  async configureGitHubPages(params: {
    owner: string;
    repo: string;
    sessionId: string;
    signal?: AbortSignal;
  }) {
    const github = await this.ensureAuthenticated(params.sessionId, params.signal);
    const existing = await this.getPagesSite(
      params.owner,
      params.repo,
      github.accessToken,
      params.signal
    );
    const body = { build_type: "workflow" };

    if (existing) {
      await this.api(`/repos/${params.owner}/${params.repo}/pages`, {
        method: "PUT",
        token: github.accessToken,
        body,
        signal: params.signal
      });
    } else {
      try {
        await this.api(`/repos/${params.owner}/${params.repo}/pages`, {
          method: "POST",
          token: github.accessToken,
          body,
          signal: params.signal
        });
      } catch (error) {
        if (!(error instanceof AppError) || (error.statusCode !== 409 && error.statusCode !== 422)) {
          throw error;
        }
        await this.api(`/repos/${params.owner}/${params.repo}/pages`, {
          method: "PUT",
          token: github.accessToken,
          body,
          signal: params.signal
        });
      }
    }

    const pages = await this.getPagesSite(
      params.owner,
      params.repo,
      github.accessToken,
      params.signal
    );
    const url = normalizeUrl(pages?.html_url) ?? defaultGitHubPagesUrl(params.owner, params.repo);
    await this.updateRepositoryHomepage(
      params.owner,
      params.repo,
      url,
      github.accessToken,
      params.signal
    );

    return {
      url,
      status: pages?.status ?? "publishing"
    };
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

  private async getPagesSite(
    owner: string,
    repo: string,
    token: string,
    signal?: AbortSignal
  ) {
    return this.api<GitHubPagesResponse | null>(`/repos/${owner}/${repo}/pages`, {
      token,
      signal,
      allow404: true
    });
  }

  private async updateRepositoryHomepage(
    owner: string,
    repo: string,
    homepage: string,
    token: string,
    signal?: AbortSignal
  ) {
    await this.api<GitHubRepoResponse>(`/repos/${owner}/${repo}`, {
      method: "PATCH",
      token,
      body: { homepage },
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
    try {
      return await this.api<GitRefResponse>(`/repos/${owner}/${repo}/git/refs`, {
        method: "POST",
        token,
        body: {
          ref: `refs/heads/${branch}`,
          sha: base.object.sha
        },
        signal
      });
    } catch (error) {
      if (!(error instanceof AppError) || (error.statusCode !== 409 && error.statusCode !== 422)) {
        throw error;
      }
      return this.api<GitRefResponse>(
        `/repos/${owner}/${repo}/git/ref/heads/${branch}`,
        { token, signal }
      );
    }
  }

  private async listTreeBlobPaths(
    owner: string,
    repo: string,
    treeSha: string,
    token: string,
    signal?: AbortSignal
  ) {
    const response = await this.api<GitTreeListingResponse>(
      `/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`,
      { token, signal }
    );
    return new Set(
      (response.tree ?? [])
        .filter((entry) => entry.type === "blob" && entry.path)
        .map((entry) => entry.path as string)
    );
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

function normalizeUrl(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function defaultGitHubPagesUrl(owner: string, repo: string) {
  const ownerPath = owner.toLowerCase();
  if (repo.toLowerCase() === `${ownerPath}.github.io`) {
    return `https://${ownerPath}.github.io/`;
  }
  return `https://${ownerPath}.github.io/${encodeURIComponent(repo)}/`;
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

export function isGitHubShaConflict(error: unknown) {
  if (!(error instanceof AppError) || error.statusCode !== 409) return false;
  const text = [error.message, error.details].filter(Boolean).join(" ").toLowerCase();
  return (
    text.includes("expected") ||
    text.includes("sha") ||
    text.includes("conflict") ||
    text.includes("is at")
  );
}

function isRetryableRefUpdateConflict(error: unknown) {
  if (!(error instanceof AppError)) return false;
  if (error.statusCode === 409) return true;
  if (error.statusCode !== 422) return false;
  const text = [error.message, error.details].filter(Boolean).join(" ").toLowerCase();
  return text.includes("fast forward") || text.includes("reference") || text.includes("ref");
}

function conflictBackoffMs(attempt: number) {
  return 250 + attempt * 450;
}

async function delay(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export const githubManager = new GitHubManager();
