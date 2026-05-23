import { config } from "../config.js";
import { getSetupStatus } from "../features/capabilities.js";
import { AppError, isAbortError, setupHelp, toReadableError } from "../lib/errors.js";
import { createId, nowIso } from "../lib/id.js";
import { projectStore } from "../state/projectStore.js";
import { codexRunner } from "./codexRunner.js";
import { errorRepairAgent } from "./errorRepairAgent.js";
import { githubManager } from "./githubManager.js";
import { inputProcessor } from "./inputProcessor.js";
import { promptArchitect } from "./promptArchitect.js";
import type { GeneratedFile, GeneratedProject, Project, ProjectError, StructuredRequirements } from "../../shared/types.js";

interface ActiveRun {
  controller: AbortController;
  inputId: string;
  kind: "create" | "edit";
  startedAt: string;
  githubSessionId: string;
}

function generationActionMessage(generated: GeneratedProject) {
  const isRescueBuild = generated.warnings.some((warning) =>
    warning.toLowerCase().includes("rescue") || warning.toLowerCase().includes("not parseable")
  );
  return isRescueBuild
    ? `deployRocket generated ${generated.files.length} rescue project files`
    : `Codex generated ${generated.files.length} project files`;
}

const pagesWorkflowPath = ".github/workflows/deployrocket-pages.yml";

function withGitHubPagesWorkflow(files: GeneratedFile[], branch: string) {
  return [
    ...files.filter((file) => file.path !== pagesWorkflowPath),
    {
      path: pagesWorkflowPath,
      content: renderGitHubPagesWorkflow(branch)
    }
  ];
}

function renderGitHubPagesWorkflow(branch: string) {
  return [
    "name: Deploy to GitHub Pages",
    "",
    "on:",
    "  push:",
    `    branches: [${JSON.stringify(branch)}]`,
    "  workflow_dispatch:",
    "",
    "permissions:",
    "  contents: read",
    "  pages: write",
    "  id-token: write",
    "",
    "concurrency:",
    "  group: pages",
    "  cancel-in-progress: true",
    "",
    "jobs:",
    "  deploy:",
    "    environment:",
    "      name: github-pages",
    "      url: ${{ steps.deployment.outputs.page_url }}",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Checkout",
    "        uses: actions/checkout@v6",
    "      - name: Set up Node",
    "        uses: actions/setup-node@v6",
    "        with:",
    "          node-version: lts/*",
    "      - name: Install dependencies",
    "        run: |",
    "          if [ -f package-lock.json ]; then",
    "            npm ci",
    "          else",
    "            npm install",
    "          fi",
    "      - name: Build",
    "        run: |",
    "          if [ \"${{ github.event.repository.name }}\" = \"${{ github.repository_owner }}.github.io\" ]; then",
    "            npm run build",
    "          else",
    "            npm run build -- --base=\"/${{ github.event.repository.name }}/\"",
    "          fi",
    "      - name: Setup Pages",
    "        uses: actions/configure-pages@v6",
    "      - name: Upload artifact",
    "        uses: actions/upload-pages-artifact@v5",
    "        with:",
    "          path: ./dist",
    "      - name: Deploy to GitHub Pages",
    "        id: deployment",
    "        uses: actions/deploy-pages@v5",
    ""
  ].join("\n");
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

    await projectStore.updateProject(projectId, (current) => {
      current.activeInputId = inputId;
      current.activeRunKind = kind;
      current.error = null;
      current.autoRepairAttempts = [];
      delete current.pagesDispatchRequestedAt;
    });

    if (config.isServerless) {
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
      await this.ensureProjectEditingReady(projectId, githubSessionId, signal);
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
          await this.githubSaveStep(projectId, githubSessionId, signal);
          break;
      }
    } catch (error) {
      await this.handleRunError(projectId, error, signal);
    }

    return this.requireProject(projectId);
  }

  async continueFailedRun(projectId: string, githubSessionId: string) {
    let project = await this.requireProject(projectId);
    if (project.status !== "FAILED") {
      throw new AppError("Only failed projects can be continued.", {
        statusCode: 409,
        code: "PROJECT_NOT_FAILED"
      });
    }

    let input = project.inputs.at(-1);
    if (!input) {
      throw new AppError("No project input is available to continue from.", {
        statusCode: 409,
        code: "CONTINUE_INPUT_MISSING"
      });
    }

    project = await this.renameProjectForContinuation(project, githubSessionId);
    projectId = project.id;
    input = project.inputs.at(-1);
    if (!input) {
      throw new AppError("No project input is available to continue from.", {
        statusCode: 409,
        code: "CONTINUE_INPUT_MISSING"
      });
    }

    const nextStatus = await this.chooseContinueStatus(projectId, project);
    await projectStore.updateProject(projectId, (current) => {
      current.activeInputId = input.id;
      current.activeRunKind = input.kind;
      current.continueContext = this.buildContinueContext(project);
      current.error = null;
      current.autoRepairAttempts = [];
      delete current.pagesDispatchRequestedAt;
    });
    await projectStore.setStatus(
      projectId,
      nextStatus,
      this.stepLabel(nextStatus),
      "Continuing failed run with previous dossier, prompt, architecture, and error context",
      "warning"
    );

    if (config.isServerless) {
      return this.runNextStep(projectId, githubSessionId);
    }

    const controller = new AbortController();
    this.activeRuns.set(projectId, {
      controller,
      inputId: input.id,
      kind: input.kind,
      startedAt: nowIso(),
      githubSessionId
    });

    void this.runFromCurrentStatus(projectId, githubSessionId, controller.signal).finally(() => {
      this.activeRuns.delete(projectId);
    });

    return this.requireProject(projectId);
  }

  async refreshProject(projectId: string, githubSessionId: string) {
    const project = await projectStore.getProject(projectId);
    if (!project) {
      throw new AppError("Project not found.", {
        statusCode: 404,
        code: "PROJECT_NOT_FOUND"
      });
    }

    const controller = new AbortController();
    const github = await githubManager.ensureAuthenticated(githubSessionId, controller.signal);
    if (project.githubUserLogin && project.githubUserLogin !== github.user.login) {
      throw new AppError(`This project belongs to GitHub account ${project.githubUserLogin}. Connect that account before refreshing it.`, {
        statusCode: 403,
        code: "GITHUB_ACCOUNT_MISMATCH"
      });
    }

    return this.syncGitHubPagesDeployment(project.id, githubSessionId, controller.signal, {
      ensureWorkflow: Boolean(project.githubLastCommitSha || project.lastCommittedPaths.length > 0)
    });
  }

  private async run(
    projectId: string,
    inputId: string,
    kind: "create" | "edit",
    githubSessionId: string,
    signal: AbortSignal
  ) {
    try {
      await this.ensureProjectEditingReady(projectId, githubSessionId, signal);

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
      await projectStore.syncPendingDefaultReadme(projectId);

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
      await projectStore.addAction(projectId, generationActionMessage(generated), "success");
      if (generated.warnings.length) {
        await projectStore.addAction(projectId, "Generation completed with warnings", "warning", generated.warnings.join("\n"));
      }

      await projectStore.setStatus(
        projectId,
        "SAVING_TO_GITHUB",
        "Saving files to GitHub",
        "Preparing GitHub repository"
      );

      await this.saveGeneratedFilesToGithub(
        projectId,
        generated.files,
        requirements.repositoryNameSuggestion,
        kind,
        githubSessionId,
        signal
      );
      await this.completeGithubSave(projectId);
    } catch (error) {
      const outcome = await this.handleRunError(projectId, error, signal);
      if (outcome === "repaired") {
        await this.runFromCurrentStatus(projectId, githubSessionId, signal);
      }
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
    await projectStore.syncPendingDefaultReadme(projectId);
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
    const { input, kind, project } = await this.requireActiveContext(projectId);
    if (!input.structuredRequirements || !input.codexPrompt) {
      throw new AppError("Codex prompt data is missing for this run.", {
        statusCode: 409,
        code: "CODEX_PROMPT_MISSING"
      });
    }

    const previousFiles = kind === "edit" || project.continueContext ? await this.loadGeneratedFiles(projectId) : [];
    const { runId, generated } = await codexRunner.generateProject(
      input.structuredRequirements,
      input.codexPrompt,
      previousFiles,
      signal,
      project.continueContext
    );
    await this.throwIfStopped(projectId, signal);

    await this.saveGeneratedProject(projectId, generated);
    await projectStore.updateProject(projectId, (current) => {
      current.codexRunId = runId;
      delete current.continueContext;
    });
    await projectStore.addAction(projectId, generationActionMessage(generated), "success");
    if (generated.warnings.length) {
      await projectStore.addAction(projectId, "Generation completed with warnings", "warning", generated.warnings.join("\n"));
    }
    await projectStore.setStatus(
      projectId,
      "SAVING_TO_GITHUB",
      "Saving files to GitHub",
      "Preparing GitHub repository"
    );
  }

  private async githubSaveStep(
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
    await this.saveGeneratedFilesToGithub(
      projectId,
      generated.files,
      input.structuredRequirements.repositoryNameSuggestion,
      kind,
      githubSessionId,
      signal
    );
    await this.completeGithubSave(projectId);
  }

  private async saveGeneratedFilesToGithub(
    projectId: string,
    files: GeneratedFile[],
    repositoryNameSuggestion: string,
    kind: "create" | "edit",
    githubSessionId: string,
    signal: AbortSignal
  ) {
    const currentProject = await this.requireProject(projectId);
    const repository = await githubManager.ensureRepository(
      currentProject,
      repositoryNameSuggestion,
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

    await projectStore.setStatus(
      projectId,
      "SAVING_TO_GITHUB",
      "Configuring GitHub Pages",
      "Configuring GitHub Pages publishing"
    );
    await this.syncGitHubPagesDeployment(projectId, githubSessionId, signal, {
      ensureWorkflow: false,
      configureIfMissing: true
    });
    await projectStore.setStatus(
      projectId,
      "SAVING_TO_GITHUB",
      "Saving files to GitHub",
      "Preparing GitHub Pages deployment"
    );

    const filesToCommit = withGitHubPagesWorkflow(files, repository.branch);
    const commitSha = await githubManager.commitFiles({
      owner: repository.owner,
      repo: repository.repo,
      branch: repository.branch,
      files: filesToCommit,
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
      current.lastCommittedPaths = files.map((file) => file.path);
      if (current.githubPagesUrl) current.githubPagesStatus = "publishing";
    });
    await projectStore.addAction(projectId, "Files committed to GitHub", "success", commitSha);
  }

  private async clearServerlessRun(projectId: string) {
    await projectStore.updateProject(projectId, (current) => {
      delete current.activeInputId;
      delete current.activeRunKind;
      delete current.pagesDispatchRequestedAt;
      delete current.continueContext;
    });
  }

  private async completeGithubSave(projectId: string) {
    await projectStore.updateProject(projectId, (current) => {
      current.status = "LIVE";
      current.currentStep = current.githubPagesUrl
        ? current.githubPagesStatus === "built"
          ? "Live on GitHub Pages"
          : "Publishing to GitHub Pages"
        : "Saved to GitHub";
      current.error = null;
      delete current.activeInputId;
      delete current.activeRunKind;
      delete current.pagesDispatchRequestedAt;
      delete current.continueContext;
    });
    const project = await this.requireProject(projectId);
    if (!project.actions.some((action) => action.message === "Project saved to GitHub")) {
      await projectStore.addAction(
        projectId,
        "Project saved to GitHub",
        "success"
      );
    }
  }

  private async syncGitHubPagesDeployment(
    projectId: string,
    githubSessionId: string,
    signal: AbortSignal,
    options: { ensureWorkflow: boolean; configureIfMissing?: boolean }
  ) {
    const project = await this.requireProject(projectId);
    if (!project.githubOwner || !project.githubRepo) return project;

    const branch = project.githubDefaultBranch ?? config.githubDefaultBranch;
    const shouldConfigure = options.ensureWorkflow || Boolean(options.configureIfMissing && !project.githubPagesUrl);
    const pages = shouldConfigure
      ? await githubManager.configureGitHubPages({
          owner: project.githubOwner,
          repo: project.githubRepo,
          sessionId: githubSessionId,
          signal
        })
      : await githubManager.getGitHubPages(
          project.githubOwner,
          project.githubRepo,
          githubSessionId,
          signal
        );

    if (!pages) return project;

    const workflowChanged = options.ensureWorkflow
      ? await this.ensureGitHubPagesWorkflowFile(project, branch, signal)
      : false;

    const hadPagesUrl = Boolean(project.githubPagesUrl);
    const nextStatus = workflowChanged || (options.ensureWorkflow && pages.status !== "built")
      ? "publishing"
      : pages.status;
    await projectStore.updateProject(projectId, (current) => {
      current.githubPagesUrl = pages.url;
      current.githubPagesStatus = nextStatus;
      current.githubPagesUpdatedAt = nowIso();

      if (current.status === "LIVE") {
        current.currentStep = pagesStep(nextStatus);
      } else if (current.status === "FAILED" && isDeploymentOnlyFailure(current)) {
        current.status = "LIVE";
        current.currentStep = pagesStep(nextStatus);
        current.error = null;
        delete current.activeInputId;
        delete current.activeRunKind;
        delete current.pagesDispatchRequestedAt;
        delete current.continueContext;
      }
    });

    const latest = await this.requireProject(projectId);
    if (!hadPagesUrl && latest.githubPagesUrl) {
      await projectStore.addAction(projectId, "GitHub Pages link ready", "success", latest.githubPagesUrl);
    }
    return this.requireProject(projectId);
  }

  private async ensureGitHubPagesWorkflowFile(project: Project, branch: string, signal: AbortSignal) {
    if (!project.githubOwner || !project.githubRepo) return false;

    const content = renderGitHubPagesWorkflow(branch);
    const existing = await githubManager.getTextFile(
      project.githubOwner,
      project.githubRepo,
      pagesWorkflowPath,
      branch,
      signal
    );
    if (existing?.content === content) return false;

    await githubManager.putTextFile({
      owner: project.githubOwner,
      repo: project.githubRepo,
      path: pagesWorkflowPath,
      branch,
      baseBranch: branch,
      content,
      message: "Configure deployRocket GitHub Pages workflow",
      signal
    });
    return true;
  }

  private async runFromCurrentStatus(projectId: string, githubSessionId: string, signal: AbortSignal) {
    try {
      while (true) {
        await this.throwIfStopped(projectId, signal);
        await this.ensureProjectEditingReady(projectId, githubSessionId, signal);
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
            await this.githubSaveStep(projectId, githubSessionId, signal);
            break;
          default:
            await this.clearServerlessRun(projectId);
            return;
        }
      }
    } catch (error) {
      const outcome = await this.handleRunError(projectId, error, signal);
      if (outcome === "repaired") {
        await this.runFromCurrentStatus(projectId, githubSessionId, signal);
      }
    }
  }

  private async handleRunError(
    projectId: string,
    error: unknown,
    signal: AbortSignal
  ): Promise<"stopped" | "repaired" | "failed"> {
    const latest = await projectStore.getProject(projectId);
    if (signal.aborted || isAbortError(error) || latest?.status === "STOPPED") {
      if (latest?.status !== "STOPPED") {
        await projectStore.stopProject(projectId, "Stopped active orchestration");
      }
      return "stopped";
    }

    const readable = toReadableError(error);
    const repair = await this.tryAutoRepair(projectId, readable);
    if (repair.repaired) return "repaired";

    const projectError: ProjectError = {
      message: repair.error.message,
      code: repair.error.code,
      details: repair.error.details,
      setupInstructions: repair.error.setupInstructions,
      at: nowIso()
    };
    await projectStore.failProject(projectId, projectError);
    return "failed";
  }

  private async tryAutoRepair(
    projectId: string,
    error: AppError
  ): Promise<{ repaired: true } | { repaired: false; error: AppError }> {
    const project = await projectStore.getProject(projectId);
    if (!project) return { repaired: false, error };

    const decision = errorRepairAgent.plan(project, error);
    if (decision.type === "repair") {
      await projectStore.applyAutoRepair(projectId, decision.plan);
      return { repaired: true };
    }

    if (decision.type === "terminal") {
      return { repaired: false, error: decision.error };
    }

    return { repaired: false, error };
  }

  private async renameProjectForContinuation(project: Project, githubSessionId: string) {
    const requirements = project.inputs.at(-1)?.structuredRequirements;
    if (!requirements) return project;

    try {
      const repository = await githubManager.renameDeployRocketRepository(
        project,
        repositoryNameFor(requirements, project),
        githubSessionId
      );
      if (!repository || repository.repo === project.githubRepo) return project;

      return await projectStore.adoptRepository(
        project,
        repository,
        "Rename deployRocket project repository",
        "Renamed GitHub repository to " + repository.repo
      );
    } catch (error) {
      const readable = toReadableError(error);
      await projectStore.addAction(
        project.id,
        "Could not rename GitHub repository automatically",
        "warning",
        readable.message
      );
      return project;
    }
  }

  private async chooseContinueStatus(projectId: string, project: Project) {
    const input = project.inputs.at(-1);
    if (!input?.structuredRequirements) return "PROCESSING_INPUT" as const;
    if (!input.codexPrompt) return "GENERATING_PROMPT" as const;

    if (this.shouldRepairWithCodex(project)) {
      return "CODEX_WORKING" as const;
    }

    const generated = await this.loadGeneratedProject(projectId);
    if (!generated.files.length) return "CODEX_WORKING" as const;
    if (!project.githubLastCommitSha || !project.lastCommittedPaths.length) {
      return "SAVING_TO_GITHUB" as const;
    }
    return "SAVING_TO_GITHUB" as const;
  }

  private stepLabel(status: "PROCESSING_INPUT" | "GENERATING_PROMPT" | "CODEX_WORKING" | "SAVING_TO_GITHUB") {
    const labels = {
      PROCESSING_INPUT: "Continuing input processing",
      GENERATING_PROMPT: "Continuing architecture prompt",
      CODEX_WORKING: "Continuing Codex generation",
      SAVING_TO_GITHUB: "Continuing GitHub save"
    };
    return labels[status];
  }

  private shouldRepairWithCodex(project: Project) {
    const code = project.error?.code;
    if (!code) return true;
    return [
      "CODEX_API_FAILURE",
      "CODEX_EMPTY_RESPONSE",
      "CODEX_EMPTY_FILE",
      "CODEX_INVALID_FILE_ENCODING",
      "CODEX_MALFORMED_RESPONSE",
      "CODEX_UNSAFE_FILE_PATH"
    ].includes(code);
  }

  private buildContinueContext(project: Project) {
    const latestInput = project.inputs.at(-1);
    const actions = project.actions.slice(-12).map((action) => ({
      at: action.at,
      message: action.message,
      level: action.level,
      status: action.status
    }));

    return JSON.stringify(
      {
        instruction: "Continue this deployRocket project from the failed stage. Preserve the original intent, but generate a compact complete v1 file set so the repository can receive real files.",
        retryDirective: "Do not repeat the oversized previous output attempt. Produce a compact Vite React TypeScript app with package.json, index.html, src/main.tsx, src/App.tsx, src/styles.css, README.md, vite.config.ts, and tsconfig.json.",
        project: {
          name: project.name,
          summary: project.summary,
          status: project.status,
          currentStep: project.currentStep,
          repository: project.githubRepoUrl
        },
        latestError: project.error,
        originalInput: latestInput?.text,
        structuredRequirements: latestInput?.structuredRequirements,
        promptSummary: latestInput?.codexPrompt
          ? {
              title: latestInput.codexPrompt.title,
              summary: latestInput.codexPrompt.summary,
              acceptanceCriteria: latestInput.codexPrompt.acceptanceCriteria.slice(0, 6)
            }
          : undefined,
        actionHistory: actions
      },
      null,
      2
    );
  }

  private async ensureProjectEditingReady(projectId: string, githubSessionId: string, signal: AbortSignal) {
    const status = getSetupStatus();

    if (!status.openaiConfigured) {
      throw new AppError("OpenAI API key is not connected.", {
        statusCode: 401,
        code: "OPENAI_CLIENT_NOT_CONNECTED",
        setupInstructions: setupHelp.openaiCustomer
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
      throw new AppError(`This project belongs to GitHub account ${project.githubUserLogin}. Connect that account before editing it.`, {
        statusCode: 403,
        code: "GITHUB_ACCOUNT_MISMATCH"
      });
    }

    await projectStore.updateProject(projectId, (current) => {
      current.githubUserLogin = github.user.login;
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

function repositoryNameFor(requirements: StructuredRequirements, project: Project) {
  return requirements.repositoryNameSuggestion || requirements.projectName || project.name || project.githubRepo || "deployrocket-project";
}

function pagesStep(status: string | undefined) {
  return status === "built" ? "Live on GitHub Pages" : "Publishing to GitHub Pages";
}

function isDeploymentOnlyFailure(project: Project) {
  const text = [project.error?.code, project.error?.message, project.error?.details]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /\b(vercel|pages?|deploy|deployment|publish|publishing)\b/.test(text);
}

export const orchestrator = new Orchestrator();
