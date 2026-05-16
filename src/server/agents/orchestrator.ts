import { config } from "../config.js";
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
  githubSessionId: string;
}

export class Orchestrator {
  private activeRuns = new Map<string, ActiveRun>();

  async start(projectId: string, inputId: string, kind: "create" | "edit", githubSessionId: string) {
    const project = await projectStore.getProject(projectId);
    if (!project) {
      throw new AppError("Project not found.", {
        statusCode: 404,
        code: "PROJECT_NOT_FOUND"
      });
    }

    if (this.activeRuns.has(projectId) || projectStore.isRunning(project.status)) {
      throw new AppError("Project is already running.", {
        statusCode: 409,
        code: "PROJECT_ALREADY_RUNNING"
      });
    }

    if (config.isServerless) {
      await projectStore.updateProject(projectId, (current) => {
        current.activeInputId = inputId;
        current.activeRunKind = kind;
        current.error = null;
        delete current.pagesDispatchRequestedAt;
      });
      await projectStore.setStatus(
        projectId,
        "PROCESSING_INPUT",
        "Processing input",
        kind === "create" ? "Processing user input" : "Processing edit request"
      );
      return;
    }

    const controller = new AbortController();
    this.activeRuns.set(projectId, {
      controller,
      inputId,
      kind,
      startedAt: nowIso(),
      githubSessionId
    });

    void this.run(projectId, inputId, kind, githubSessionId, controller.signal).finally(() => {
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

  async runNextStep(projectId: string, githubSessionId: string) {
    const project = await this.requireProject(projectId);
    if (!projectStore.isRunning(project.status)) return project;

    if (!config.isServerless && this.isActive(projectId)) {
      return project;
    }

    const controller = new AbortController();
    const signal = controller.signal;

    try {
      await this.ensureSetup(projectId, githubSessionId, signal);
      const current = await this.requireProject(projectId);

      switch (current.status) {
        case "PROCESSING_INPUT":
          await this.processInputStep(projectId, signal);
          break;
        case "GENERATING_PROMPT":
          await this.generatePromptStep(projectId, signal);
          break;
        case "SENDING_TO_CODEX":
          await projectStore.setStatus(
            projectId,
            "CODEX_WORKING",
            "Codex is generating project files",
            "Codex started generation"
          );
          break;
        case "CODEX_WORKING":
          await this.codexGenerationStep(projectId, signal);
          break;
        case "SAVING_TO_GITHUB":
          await this.githubSaveAndDeployStep(projectId, githubSessionId, signal);
          break;
        case "DEPLOYING": {
          const latest = await this.requireProject(projectId);
          const result = await pagesDeployManager.pollProject(latest, githubSessionId, signal);
          if (result.done) await this.clearServerlessRun(projectId);
          break;
        }
      }
    } catch (error) {
      const latest = await projectStore.getProject(projectId);
      if (signal.aborted || isAbortError(error) || latest?.status === "STOPPED") {
        if (latest?.status !== "STOPPED") {
          await projectStore.stopProject(projectId, "Stopped active orchestration");
        }
      } else {
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

    return this.requireProject(projectId);
  }

  async refreshDeployment(projectId: string, githubSessionId: string) {
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
    const github = await githubManager.ensureAuthenticated(githubSessionId, controller.signal);
    if (project.githubUserLogin && project.githubUserLogin !== github.user.login) {
      throw new AppError(`This project belongs to GitHub account ${project.githubUserLogin}. Connect that account before refreshing deployment status.`, {
        statusCode: 403,
        code: "GITHUB_ACCOUNT_MISMATCH"
      });
    }
    await pagesDeployManager.pollProject(project, githubSessionId, controller.signal);
    return projectStore.getProject(projectId);
  }

  private async run(
    projectId: string,
    inputId: string,
    kind: "create" | "edit",
    githubSessionId: string,
    signal: AbortSignal
  ) {
    try {
      await this.ensureSetup(projectId, githubSessionId, signal);

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
        githubSessionId,
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
        sessionId: githubSessionId,
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

      await githubManager.enablePages(repository.owner, repository.repo, githubSessionId, signal);
      await projectStore.addAction(projectId, "GitHub Pages configured for workflow deployment", "success");

      const dispatched = await githubManager.dispatchPagesWorkflow(
        repository.owner,
        repository.repo,
        repository.branch,
        githubSessionId,
        signal
      );
      await projectStore.addAction(
        projectId,
        dispatched
          ? "Triggered GitHub Pages workflow"
          : "Waiting for push-triggered GitHub Pages workflow",
        "info"
      );

      await this.monitorDeployment(projectId, githubSessionId, signal);
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

  private async processInputStep(projectId: string, signal: AbortSignal) {
    const { input } = await this.requireActiveContext(projectId);
    const requirements = await inputProcessor.process(input, signal);
    await this.throwIfStopped(projectId, signal);

    await projectStore.updateProject(projectId, (current) => {
      current.name = requirements.projectName || current.name;
      current.summary = requirements.summary || current.summary;
      const targetInput = current.inputs.find((item) => item.id === input.id);
      if (targetInput) targetInput.structuredRequirements = requirements;
    });
    await projectStore.addAction(projectId, "Generated structured product requirements", "success");
    await projectStore.setStatus(
      projectId,
      "GENERATING_PROMPT",
      "Generating Codex prompt",
      "Creating architecture and implementation prompt"
    );
  }

  private async generatePromptStep(projectId: string, signal: AbortSignal) {
    const { input, kind } = await this.requireActiveContext(projectId);
    if (!input.structuredRequirements) {
      throw new AppError("Structured requirements are missing for this run.", {
        statusCode: 409,
        code: "STRUCTURED_REQUIREMENTS_MISSING"
      });
    }

    const previousFiles = kind === "edit" ? await this.loadGeneratedFiles(projectId) : [];
    const promptPlan = await promptArchitect.createPromptPlan(
      input.structuredRequirements,
      kind,
      previousFiles,
      input.text,
      signal
    );
    await this.throwIfStopped(projectId, signal);

    await projectStore.updateProject(projectId, (current) => {
      const targetInput = current.inputs.find((item) => item.id === input.id);
      if (targetInput) targetInput.codexPrompt = promptPlan;
    });
    await projectStore.addAction(projectId, "Generated structured Codex prompt", "success");
    await projectStore.setStatus(
      projectId,
      "SENDING_TO_CODEX",
      "Submitting prompt to Codex",
      "Sent prompt to Codex"
    );
  }

  private async codexGenerationStep(projectId: string, signal: AbortSignal) {
    const { input, kind } = await this.requireActiveContext(projectId);
    if (!input.structuredRequirements || !input.codexPrompt) {
      throw new AppError("Codex prompt data is missing for this run.", {
        statusCode: 409,
        code: "CODEX_PROMPT_MISSING"
      });
    }

    const previousFiles = kind === "edit" ? await this.loadGeneratedFiles(projectId) : [];
    const { runId, generated } = await codexRunner.generateProject(
      input.structuredRequirements,
      input.codexPrompt,
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
      "Codex generated " + generated.files.length + " project files",
      "success"
    );
    await projectStore.setStatus(
      projectId,
      "SAVING_TO_GITHUB",
      "Saving files to GitHub",
      "Preparing GitHub repository"
    );
  }

  private async githubSaveAndDeployStep(
    projectId: string,
    githubSessionId: string,
    signal: AbortSignal
  ) {
    const { input, kind } = await this.requireActiveContext(projectId);
    if (!input.structuredRequirements) {
      throw new AppError("Structured requirements are missing for GitHub save.", {
        statusCode: 409,
        code: "STRUCTURED_REQUIREMENTS_MISSING"
      });
    }

    const generated = await this.loadGeneratedProject(projectId);
    const currentProject = await this.requireProject(projectId);
    const repository = await githubManager.ensureRepository(
      currentProject,
      input.structuredRequirements.repositoryNameSuggestion,
      githubSessionId,
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
      sessionId: githubSessionId,
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

    await githubManager.enablePages(repository.owner, repository.repo, githubSessionId, signal);
    await projectStore.addAction(projectId, "GitHub Pages configured for workflow deployment", "success");

    const dispatched = await githubManager.dispatchPagesWorkflow(
      repository.owner,
      repository.repo,
      repository.branch,
      githubSessionId,
      signal
    );
    await projectStore.updateProject(projectId, (current) => {
      current.pagesDispatchRequestedAt = nowIso();
    });
    await projectStore.addAction(
      projectId,
      dispatched
        ? "Triggered GitHub Pages workflow"
        : "Waiting for push-triggered GitHub Pages workflow",
      "info"
    );
  }

  private async clearServerlessRun(projectId: string) {
    await projectStore.updateProject(projectId, (current) => {
      delete current.activeInputId;
      delete current.activeRunKind;
      delete current.pagesDispatchRequestedAt;
    });
  }

  private async ensureSetup(projectId: string, githubSessionId: string, signal: AbortSignal) {
    const status = await githubManager.getSetupStatus(githubSessionId);

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

    const github = await githubManager.ensureAuthenticated(githubSessionId, signal);
    const project = await this.requireProject(projectId);

    if (project.githubUserLogin && project.githubUserLogin !== github.user.login) {
      throw new AppError(`This project belongs to GitHub account ${project.githubUserLogin}. Connect that account before editing or deploying it.`, {
        statusCode: 403,
        code: "GITHUB_ACCOUNT_MISMATCH"
      });
    }

    await projectStore.updateProject(projectId, (current) => {
      current.githubUserLogin = github.user.login;
    });
  }

  private async monitorDeployment(projectId: string, githubSessionId: string, signal: AbortSignal) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await this.throwIfStopped(projectId, signal);
      const project = await this.requireProject(projectId);
      const result = await pagesDeployManager.pollProject(project, githubSessionId, signal);
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

  private async requireActiveContext(projectId: string) {
    const project = await this.requireProject(projectId);
    const inputId = project.activeInputId ?? project.inputs.at(-1)?.id;
    const input = project.inputs.find((item) => item.id === inputId);
    if (!input) {
      throw new AppError("Input record not found for the active run.", {
        statusCode: 404,
        code: "INPUT_NOT_FOUND"
      });
    }

    return {
      project,
      input,
      kind: project.activeRunKind ?? input.kind
    };
  }

  private async loadGeneratedProject(projectId: string): Promise<GeneratedProject> {
    const project = await this.requireProject(projectId);
    if (!project.githubOwner || !project.githubRepo) {
      return {
        files: [],
        implementationSummary: "",
        setupNotes: [],
        warnings: []
      };
    }

    const file = await githubManager.getTextFile(
      project.githubOwner,
      project.githubRepo,
      this.generatedKey("latest"),
      config.githubStateBranch
    );
    if (!file) {
      return {
        files: [],
        implementationSummary: "",
        setupNotes: [],
        warnings: []
      };
    }
    return JSON.parse(file.content) as GeneratedProject;
  }

  private async loadGeneratedFiles(projectId: string): Promise<GeneratedFile[]> {
    const project = await this.requireProject(projectId);
    if (project.githubOwner && project.githubRepo && project.lastCommittedPaths.length > 0) {
      return githubManager.readTextFiles(
        project.githubOwner,
        project.githubRepo,
        project.githubDefaultBranch ?? config.githubDefaultBranch,
        project.lastCommittedPaths
      );
    }

    const parsed = await this.loadGeneratedProject(projectId);
    return parsed.files ?? [];
  }

  private async saveGeneratedProject(projectId: string, generated: GeneratedProject) {
    const project = await this.requireProject(projectId);
    if (!project.githubOwner || !project.githubRepo) return;

    const content = JSON.stringify(generated, null, 2);
    await githubManager.putTextFile({
      owner: project.githubOwner,
      repo: project.githubRepo,
      path: this.generatedKey("latest"),
      branch: config.githubStateBranch,
      baseBranch: project.githubDefaultBranch ?? config.githubDefaultBranch,
      content,
      message: "Update generated deployRocket file snapshot"
    });
    await githubManager.putTextFile({
      owner: project.githubOwner,
      repo: project.githubRepo,
      path: this.generatedKey(createId("generation") + ".json"),
      branch: config.githubStateBranch,
      baseBranch: project.githubDefaultBranch ?? config.githubDefaultBranch,
      content,
      message: "Archive generated deployRocket file snapshot"
    });
  }

  private generatedKey(name: string) {
    return "generated/" + name + (name.endsWith(".json") ? "" : ".json");
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
