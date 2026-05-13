import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "../config.js";
import { AppError, isAbortError, setupHelp, toReadableError } from "../lib/errors.js";
import { createId, nowIso } from "../lib/id.js";
import { projectStore } from "../state/projectStore.js";
import { codexRunner } from "./codexRunner.js";
import { githubManager } from "./githubManager.js";
import { inputProcessor } from "./inputProcessor.js";
import { pagesDeployManager } from "./pagesDeployManager.js";
import { promptArchitect } from "./promptArchitect.js";
import type { GeneratedFile, GeneratedProject, ProjectError } from "../../shared/types.js";

interface ActiveRun {
  controller: AbortController;
  inputId: string;
  kind: "create" | "edit";
  startedAt: string;
}

export class Orchestrator {
  private activeRuns = new Map<string, ActiveRun>();

  start(projectId: string, inputId: string, kind: "create" | "edit") {
    if (this.activeRuns.has(projectId)) {
      throw new AppError("Project is already running.", {
        statusCode: 409,
        code: "PROJECT_ALREADY_RUNNING"
      });
    }

    const controller = new AbortController();
    this.activeRuns.set(projectId, {
      controller,
      inputId,
      kind,
      startedAt: nowIso()
    });

    void this.run(projectId, inputId, kind, controller.signal).finally(() => {
      this.activeRuns.delete(projectId);
    });
  }

  async stop(projectId: string) {
    const run = this.activeRuns.get(projectId);
    if (run) run.controller.abort();
    await projectStore.stopProject(projectId);
  }

  isActive(projectId: string) {
    return this.activeRuns.has(projectId);
  }

  async refreshDeployment(projectId: string) {
    const project = await projectStore.getProject(projectId);
    if (!project) {
      throw new AppError("Project not found.", {
        statusCode: 404,
        code: "PROJECT_NOT_FOUND"
      });
    }

    if (project.status !== "DEPLOYING" && project.status !== "LIVE") {
      return project;
    }

    const controller = new AbortController();
    await pagesDeployManager.pollProject(project, controller.signal);
    return projectStore.getProject(projectId);
  }

  private async run(
    projectId: string,
    inputId: string,
    kind: "create" | "edit",
    signal: AbortSignal
  ) {
    try {
      await this.ensureSetup(signal);

      await projectStore.setStatus(
        projectId,
        "PROCESSING_INPUT",
        "Processing input",
        kind === "create" ? "Processing user input" : "Processing edit request"
      );

      const project = await this.requireProject(projectId);
      const input = project.inputs.find((item) => item.id === inputId);
      if (!input) {
        throw new AppError("Input record not found.", {
          statusCode: 404,
          code: "INPUT_NOT_FOUND"
        });
      }

      const requirements = await inputProcessor.process(input, signal);
      await this.throwIfStopped(projectId, signal);

      await projectStore.updateProject(projectId, (current) => {
        current.name = requirements.projectName || current.name;
        current.summary = requirements.summary || current.summary;
        const targetInput = current.inputs.find((item) => item.id === inputId);
        if (targetInput) targetInput.structuredRequirements = requirements;
      });
      await projectStore.addAction(projectId, "Generated structured product requirements", "success");

      await projectStore.setStatus(
        projectId,
        "GENERATING_PROMPT",
        "Generating Codex prompt",
        "Creating architecture and implementation prompt"
      );

      const previousFiles = kind === "edit" ? await this.loadGeneratedFiles(projectId) : [];
      const promptPlan = await promptArchitect.createPromptPlan(
        requirements,
        kind,
        previousFiles,
        input.text,
        signal
      );
      await this.throwIfStopped(projectId, signal);

      await projectStore.updateProject(projectId, (current) => {
        const targetInput = current.inputs.find((item) => item.id === inputId);
        if (targetInput) targetInput.codexPrompt = promptPlan;
      });
      await projectStore.addAction(projectId, "Generated structured Codex prompt", "success");

      await projectStore.setStatus(
        projectId,
        "SENDING_TO_CODEX",
        "Submitting prompt to Codex",
        "Sent prompt to Codex"
      );
      await projectStore.setStatus(
        projectId,
        "CODEX_WORKING",
        "Codex is generating project files",
        "Codex started generation"
      );

      const { runId, generated } = await codexRunner.generateProject(
        requirements,
        promptPlan,
        previousFiles,
        signal
      );
      await this.throwIfStopped(projectId, signal);

      await this.saveGeneratedProject(projectId, generated);
      await projectStore.updateProject(projectId, (current) => {
        current.codexRunId = runId;
      });
      await projectStore.addAction(
        projectId,
        `Codex generated ${generated.files.length} project files`,
        "success"
      );

      await projectStore.setStatus(
        projectId,
        "SAVING_TO_GITHUB",
        "Saving files to GitHub",
        "Preparing GitHub repository"
      );

      const currentProject = await this.requireProject(projectId);
      const repository = await githubManager.ensureRepository(
        currentProject,
        requirements.repositoryNameSuggestion,
        signal
      );
      await this.throwIfStopped(projectId, signal);

      await projectStore.updateProject(projectId, (current) => {
        current.githubOwner = repository.owner;
        current.githubRepo = repository.repo;
        current.githubRepoUrl = repository.url;
        current.githubDefaultBranch = repository.branch;
      });

      const commitSha = await githubManager.commitFiles({
        owner: repository.owner,
        repo: repository.repo,
        branch: repository.branch,
        files: generated.files,
        previousPaths: currentProject.lastCommittedPaths,
        message:
          kind === "create"
            ? "Create project from deployRocket"
            : "Update project from deployRocket",
        signal
      });
      await this.throwIfStopped(projectId, signal);

      await projectStore.updateProject(projectId, (current) => {
        current.githubLastCommitSha = commitSha;
        current.lastCommittedPaths = generated.files.map((file) => file.path);
      });
      await projectStore.addAction(projectId, "Files committed to GitHub", "success", commitSha);

      await projectStore.setStatus(
        projectId,
        "DEPLOYING",
        "Configuring GitHub Pages",
        "GitHub Pages deployment started"
      );

      await githubManager.enablePages(repository.owner, repository.repo, signal);
      await projectStore.addAction(projectId, "GitHub Pages configured for workflow deployment", "success");

      const dispatched = await githubManager.dispatchPagesWorkflow(
        repository.owner,
        repository.repo,
        repository.branch,
        signal
      );
      await projectStore.addAction(
        projectId,
        dispatched
          ? "Triggered GitHub Pages workflow"
          : "Waiting for push-triggered GitHub Pages workflow",
        "info"
      );

      await this.monitorDeployment(projectId, signal);
    } catch (error) {
      const latest = await projectStore.getProject(projectId);
      if (signal.aborted || isAbortError(error) || latest?.status === "STOPPED") {
        if (latest?.status !== "STOPPED") {
          await projectStore.stopProject(projectId, "Stopped active orchestration");
        }
        return;
      }

      const readable = toReadableError(error);
      const projectError: ProjectError = {
        message: readable.message,
        code: readable.code,
        details: readable.details,
        setupInstructions: readable.setupInstructions,
        at: nowIso()
      };
      await projectStore.failProject(projectId, projectError);
    }
  }

  private async ensureSetup(signal: AbortSignal) {
    const status = await githubManager.getSetupStatus();

    if (!status.openaiConfigured) {
      throw new AppError("OpenAI is not configured.", {
        statusCode: 500,
        code: "OPENAI_NOT_CONFIGURED",
        setupInstructions: setupHelp.openai
      });
    }

    if (!status.githubOAuthConfigured) {
      throw new AppError("GitHub OAuth is not configured.", {
        statusCode: 500,
        code: "GITHUB_OAUTH_NOT_CONFIGURED",
        setupInstructions: setupHelp.githubOAuth
      });
    }

    if (!status.githubConnected) {
      throw new AppError("GitHub is not connected.", {
        statusCode: 401,
        code: "GITHUB_NOT_CONNECTED",
        setupInstructions: setupHelp.githubToken
      });
    }

    await githubManager.ensureAuthenticated(signal);
  }

  private async monitorDeployment(projectId: string, signal: AbortSignal) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await this.throwIfStopped(projectId, signal);
      const project = await this.requireProject(projectId);
      const result = await pagesDeployManager.pollProject(project, signal);
      if (result.done) return;
      await sleep(5000, signal);
    }

    throw new AppError("Timed out while waiting for GitHub Pages deployment.", {
      statusCode: 504,
      code: "GITHUB_PAGES_TIMEOUT",
      setupInstructions: [
        "Open the repository Actions tab and inspect the Pages workflow.",
        "Use Refresh in the project screen to poll again.",
        "If the workflow failed, use Edit to fix the project and redeploy."
      ]
    });
  }

  private async throwIfStopped(projectId: string, signal: AbortSignal) {
    if (signal.aborted) {
      throw new AppError("Project run was stopped.", {
        statusCode: 499,
        code: "RUN_STOPPED"
      });
    }

    const project = await projectStore.getProject(projectId);
    if (project?.status === "STOPPED") {
      throw new AppError("Project run was stopped.", {
        statusCode: 499,
        code: "RUN_STOPPED"
      });
    }
  }

  private async requireProject(projectId: string) {
    const project = await projectStore.getProject(projectId);
    if (!project) {
      throw new AppError("Project not found.", {
        statusCode: 404,
        code: "PROJECT_NOT_FOUND"
      });
    }
    return project;
  }

  private async loadGeneratedFiles(projectId: string): Promise<GeneratedFile[]> {
    try {
      const raw = await fs.readFile(this.generatedPath(projectId), "utf8");
      const parsed = JSON.parse(raw) as GeneratedProject;
      return parsed.files ?? [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async saveGeneratedProject(projectId: string, generated: GeneratedProject) {
    const projectDir = path.join(paths.generatedDir, projectId);
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(this.generatedPath(projectId), `${JSON.stringify(generated, null, 2)}\n`, "utf8");
    await fs.writeFile(
      path.join(projectDir, `${createId("generation")}.json`),
      `${JSON.stringify(generated, null, 2)}\n`,
      "utf8"
    );
  }

  private generatedPath(projectId: string) {
    return path.join(paths.generatedDir, projectId, "latest.json");
  }
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

export const orchestrator = new Orchestrator();
