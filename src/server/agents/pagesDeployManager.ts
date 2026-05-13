import { AppError } from "../lib/errors.js";
import { createId, nowIso } from "../lib/id.js";
import { githubManager } from "./githubManager.js";
import { projectStore } from "../state/projectStore.js";
import type { Project } from "../../shared/types.js";

export class PagesDeployManager {
  async pollProject(project: Project, githubSessionId: string, signal?: AbortSignal) {
    if (!project.githubOwner || !project.githubRepo) {
      throw new AppError("Project has no GitHub repository to deploy.", {
        statusCode: 409,
        code: "PROJECT_REPOSITORY_MISSING"
      });
    }

    const branch = project.githubDefaultBranch ?? "main";
    const run = await githubManager.getLatestPagesRun(
      project.githubOwner,
      project.githubRepo,
      branch,
      githubSessionId,
      signal
    );

    if (!run) {
      await projectStore.updateProject(project.id, (current) => {
        current.currentStep = "Waiting for GitHub Actions to register the Pages workflow";
      });
      return { done: false as const };
    }

    await projectStore.updateProject(project.id, (current) => {
      current.githubWorkflowRunId = run.id;
      current.deployments.push({
        id: createId("deploy"),
        at: nowIso(),
        status: run.status,
        conclusion: run.conclusion ?? undefined,
        workflowRunUrl: run.html_url
      });
      current.deployments = current.deployments.slice(-60);
      current.currentStep =
        run.status === "completed"
          ? `GitHub Pages workflow completed: ${run.conclusion ?? "unknown"}`
          : `GitHub Pages workflow ${run.status}`;
    });

    if (run.status !== "completed") {
      return { done: false as const };
    }

    if (run.conclusion === "success") {
      const pages = await githubManager.getPages(project.githubOwner, project.githubRepo, githubSessionId, signal);
      const pagesUrl =
        pages?.html_url ??
        `https://${project.githubOwner}.github.io/${project.githubRepo}/`;

      await projectStore.updateProject(project.id, (current) => {
        current.status = "LIVE";
        current.currentStep = "Deployment completed";
        current.githubPagesUrl = pagesUrl;
        current.error = null;
        current.deployments.push({
          id: createId("deploy"),
          at: nowIso(),
          status: "completed",
          conclusion: "success",
          workflowRunUrl: run.html_url,
          pagesUrl
        });
      });
      await projectStore.addAction(project.id, "Deployment completed", "success");
      return { done: true as const, success: true as const, pagesUrl };
    }

    throw new AppError("GitHub Pages deployment failed.", {
      statusCode: 502,
      code: "GITHUB_PAGES_DEPLOYMENT_FAILED",
      details: `Workflow conclusion: ${run.conclusion ?? "unknown"} (${run.html_url})`,
      setupInstructions: [
        "Open the workflow run URL in the project history.",
        "Check whether npm install or npm run build failed.",
        "Fix the project with the Edit flow and redeploy."
      ]
    });
  }
}

export const pagesDeployManager = new PagesDeployManager();
