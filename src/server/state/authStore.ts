import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "../config.js";

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

interface AuthDatabase {
  githubBySession: Record<string, GitHubAuthState>;
}

interface LegacyAuthDatabase {
  github?: GitHubAuthState | null;
  githubBySession?: Record<string, GitHubAuthState>;
}

const authPath = path.join(paths.dataDir, "auth.json");

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class AuthStore {
  private db: AuthDatabase = { githubBySession: {} };
  private ready: Promise<void>;
  private writeQueue = Promise.resolve();

  constructor() {
    this.ready = this.load();
  }

  private async load() {
    try {
      const raw = await fs.readFile(authPath, "utf8");
      const parsed = JSON.parse(raw) as LegacyAuthDatabase;
      this.db = { githubBySession: parsed.githubBySession ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.db = { githubBySession: {} };
    }
    await this.write();
  }

  private async write() {
    await fs.mkdir(paths.dataDir, { recursive: true });
    const tmpPath = `${authPath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(this.db, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, authPath);
  }

  private async mutate<T>(fn: () => T | Promise<T>): Promise<T> {
    await this.ready;
    const run = async () => {
      const result = await fn();
      await this.write();
      return clone(result);
    };

    const next = this.writeQueue.then(run, run);
    this.writeQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async getGithub(sessionId: string) {
    await this.ready;
    const github = this.db.githubBySession[sessionId];
    return github ? clone(github) : null;
  }

  async findSessionIdForUser(login: string) {
    await this.ready;
    const normalizedLogin = login.toLowerCase();
    const match = Object.entries(this.db.githubBySession).find(
      ([, github]) => github.user.login.toLowerCase() === normalizedLogin
    );
    return match?.[0] ?? null;
  }

  async setGithub(sessionId: string, github: GitHubAuthState) {
    return this.mutate(() => {
      this.db.githubBySession[sessionId] = github;
      return this.db.githubBySession[sessionId];
    });
  }

  async clearGithub(sessionId: string) {
    return this.mutate(() => {
      delete this.db.githubBySession[sessionId];
      return true;
    });
  }
}

export const authStore = new AuthStore();
