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
  github: GitHubAuthState | null;
}

const authPath = path.join(paths.dataDir, "auth.json");

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class AuthStore {
  private db: AuthDatabase = { github: null };
  private ready: Promise<void>;
  private writeQueue = Promise.resolve();

  constructor() {
    this.ready = this.load();
  }

  private async load() {
    try {
      const raw = await fs.readFile(authPath, "utf8");
      const parsed = JSON.parse(raw) as AuthDatabase;
      this.db = { github: parsed.github ?? null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.db = { github: null };
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

  async getGithub() {
    await this.ready;
    return this.db.github ? clone(this.db.github) : null;
  }

  async setGithub(github: GitHubAuthState) {
    return this.mutate(() => {
      this.db.github = github;
      return this.db.github;
    });
  }

  async clearGithub() {
    return this.mutate(() => {
      this.db.github = null;
      return true;
    });
  }
}

export const authStore = new AuthStore();
