import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "../config.js";
import { createId, nowIso } from "../lib/id.js";
import type {
  ActionLevel,
  JsonDatabase,
  Project,
  ProjectAction,
  ProjectError,
  ProjectInputRecord,
  ProjectStatus
} from "../../shared/types.js";

const dbPath = path.join(paths.dataDir, "db.json");

const runningStatuses: ProjectStatus[] = [
  "PROCESSING_INPUT",
  "GENERATING_PROMPT",
  "SENDING_TO_CODEX",
  "CODEX_WORKING",
  "SAVING_TO_GITHUB",
  "DEPLOYING"
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createEmptyDb(): JsonDatabase {
  return { projects: [] };
}

async function readDbFile(): Promise<JsonDatabase> {
  try {
    const raw = await fs.readFile(dbPath, "utf8");
    const parsed = JSON.parse(raw) as JsonDatabase;
    return { projects: Array.isArray(parsed.projects) ? parsed.projects : [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createEmptyDb();
    }
    throw error;
  }
}

async function writeDbFile(db: JsonDatabase) {
  await fs.mkdir(paths.dataDir, { recursive: true });
  const tmpPath = `${dbPath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(db, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, dbPath);
}

class ProjectStore {
  private db: JsonDatabase = createEmptyDb();
  private ready: Promise<void>;
  private writeQueue = Promise.resolve();

  constructor() {
    this.ready = this.load();
  }

  private async load() {
    this.db = await readDbFile();
    await writeDbFile(this.db);
  }

  private async mutate<T>(fn: (db: JsonDatabase) => T | Promise<T>): Promise<T> {
    await this.ready;

    const run = async () => {
      const result = await fn(this.db);
      await writeDbFile(this.db);
      return clone(result);
    };

    const next = this.writeQueue.then(run, run);
    this.writeQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async listProjects() {
    await this.ready;
    return clone(
      [...this.db.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    );
  }

  async getProject(id: string) {
    await this.ready;
    const project = this.db.projects.find((item) => item.id === id);
    return project ? clone(project) : null;
  }

  async createProject(input: ProjectInputRecord) {
    const now = nowIso();
    const project: Project = {
      id: createId("project"),
      name: "Untitled project",
      summary: "Waiting for input processing.",
      status: "IDLE",
      currentStep: "Ready",
      error: null,
      createdAt: now,
      updatedAt: now,
      actions: [
        {
          id: createId("action"),
          at: now,
          message: "Received user input",
          level: "info",
          status: "IDLE"
        }
      ],
      inputs: [input],
      deployments: [],
      lastCommittedPaths: []
    };

    return this.mutate((db) => {
      db.projects.unshift(project);
      return project;
    });
  }

  async addInput(projectId: string, input: ProjectInputRecord) {
    return this.updateProject(projectId, (project) => {
      project.inputs.push(input);
      project.error = null;
      this.pushAction(project, "Received edit request", "info");
    });
  }

  async updateProject(projectId: string, updater: (project: Project) => void) {
    return this.mutate((db) => {
      const project = db.projects.find((item) => item.id === projectId);
      if (!project) return null;

      updater(project);
      project.updatedAt = nowIso();
      return project;
    });
  }

  async setStatus(
    projectId: string,
    status: ProjectStatus,
    currentStep: string,
    actionMessage?: string,
    level: ActionLevel = "info"
  ) {
    return this.updateProject(projectId, (project) => {
      project.status = status;
      project.currentStep = currentStep;
      if (status !== "FAILED") project.error = null;
      if (actionMessage) this.pushAction(project, actionMessage, level, status);
    });
  }

  async addAction(
    projectId: string,
    message: string,
    level: ActionLevel = "info",
    details?: string
  ) {
    return this.updateProject(projectId, (project) => {
      this.pushAction(project, message, level, project.status, details);
    });
  }

  async failProject(projectId: string, error: ProjectError) {
    return this.updateProject(projectId, (project) => {
      project.status = "FAILED";
      project.currentStep = "Failed";
      project.error = error;
      this.pushAction(project, error.message, "error", "FAILED", error.details);
    });
  }

  async stopProject(projectId: string, message = "Stopped by user") {
    return this.updateProject(projectId, (project) => {
      project.status = "STOPPED";
      project.currentStep = "Stopped";
      this.pushAction(project, message, "warning", "STOPPED");
    });
  }

  async recoverInterruptedProjects() {
    return this.mutate((db) => {
      const recovered: Project[] = [];
      for (const project of db.projects) {
        if (runningStatuses.includes(project.status)) {
          project.status = "STOPPED";
          project.currentStep = "Stopped after backend restart";
          project.updatedAt = nowIso();
          this.pushAction(
            project,
            "The backend restarted while this project was running",
            "warning",
            "STOPPED"
          );
          recovered.push(project);
        }
      }
      return recovered;
    });
  }

  isRunning(status: ProjectStatus) {
    return runningStatuses.includes(status);
  }

  private pushAction(
    project: Project,
    message: string,
    level: ActionLevel,
    status: ProjectStatus = project.status,
    details?: string
  ) {
    const action: ProjectAction = {
      id: createId("action"),
      at: nowIso(),
      message,
      level,
      status,
      details
    };

    project.actions.push(action);
    project.actions = project.actions.slice(-250);
  }
}

export const projectStore = new ProjectStore();
export const runningProjectStatuses = runningStatuses;
