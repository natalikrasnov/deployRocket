import { config, isVercelConfigured } from "../config.js";
import { AppError, setupHelp } from "../lib/errors.js";
import { createId, nowIso, slugify } from "../lib/id.js";
import { projectStore } from "../state/projectStore.js";
import type { GeneratedFile, Project } from "../../shared/types.js";

interface VercelDeploymentResponse {
  id: string;
  url?: string;
  name?: string;
  status?: string;
  readyState?: string;
  inspectorUrl?: string | null;
  errorMessage?: string;
}

interface VercelApiOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

const apiBase = "https://api.vercel.com";

export class VercelDeployManager {
  async createDeployment(projectId: string, files: GeneratedFile[], signal?: AbortSignal) {
    if (!isVercelConfigured()) {
      throw new AppError("Vercel is not configured.", {
        statusCode: 500,
        code: "VERCEL_NOT_CONFIGURED",
        setupInstructions: setupHelp.vercel
      });
    }

    const project = await this.requireProject(projectId);
    const name = vercelProjectName(project);
    const deployment = await this.api<VercelDeploymentResponse>("/v13/deployments", {
      method: "POST",
      body: {
        name,
        project: name,
        target: config.vercelTarget,
        files: files.map((file) => ({
          file: file.path,
          data: file.content
        })),
        gitMetadata: project.githubRepoUrl
          ? {
              remoteUrl: project.githubRepoUrl,
              commitRef: project.githubDefaultBranch ?? config.githubDefaultBranch,
              commitSha: project.githubLastCommitSha,
              commitMessage: "Deploy from deployRocket",
              dirty: false
            }
          : undefined,
        meta: {
          deployRocketProjectId: project.id,
          githubRepo: project.githubOwner && project.githubRepo ? `${project.githubOwner}/${project.githubRepo}` : undefined
        },
        projectSettings: {
          framework: "vite",
          installCommand: "npm install",
          buildCommand: "npm run build",
          outputDirectory: "dist",
          devCommand: "npm run dev"
        }
      },
      signal
    });

    const deploymentUrl = toPublicUrl(deployment.url);
    const status = deployment.readyState ?? deployment.status ?? "INITIALIZING";

    await projectStore.updateProject(projectId, (current) => {
      current.vercelDeploymentId = deployment.id;
      current.vercelDeploymentUrl = deploymentUrl;
      current.deploymentUrl = deploymentUrl;
      current.deploymentStartedAt = nowIso();
      current.deployments.push({
        id: createId("deploy"),
        at: nowIso(),
        provider: "vercel",
        deploymentId: deployment.id,
        status,
        deploymentUrl,
        inspectorUrl: deployment.inspectorUrl ?? undefined
      });
      current.deployments = current.deployments.slice(-60);
      current.currentStep = `Vercel deployment ${status.toLowerCase()}`;
    });

    await projectStore.addAction(
      projectId,
      "Vercel deployment created",
      "info",
      deploymentUrl ?? deployment.id
    );

    return deployment;
  }

  async pollProject(project: Project, signal?: AbortSignal) {
    if (!project.vercelDeploymentId) {
      throw new AppError("Project has no Vercel deployment to poll.", {
        statusCode: 409,
        code: "VERCEL_DEPLOYMENT_MISSING"
      });
    }

    const deployment = await this.api<VercelDeploymentResponse>(
      `/v13/deployments/${encodeURIComponent(project.vercelDeploymentId)}`,
      { signal }
    );
    const status = deployment.readyState ?? deployment.status ?? "UNKNOWN";
    const deploymentUrl =
      toPublicUrl(deployment.url) ?? project.deploymentUrl ?? project.vercelDeploymentUrl;

    await projectStore.updateProject(project.id, (current) => {
      current.vercelDeploymentId = deployment.id;
      current.vercelDeploymentUrl = deploymentUrl;
      current.deploymentUrl = deploymentUrl;
      current.deployments.push({
        id: createId("deploy"),
        at: nowIso(),
        provider: "vercel",
        deploymentId: deployment.id,
        status,
        conclusion: isTerminalFailure(status) ? "failure" : status === "READY" ? "success" : undefined,
        deploymentUrl,
        inspectorUrl: deployment.inspectorUrl ?? undefined
      });
      current.deployments = current.deployments.slice(-60);
      current.currentStep =
        status === "READY" ? "Vercel deployment completed" : `Vercel deployment ${status.toLowerCase()}`;
    });

    if (status === "READY") {
      await projectStore.updateProject(project.id, (current) => {
        current.status = "LIVE";
        current.currentStep = "Deployment completed";
        current.vercelDeploymentUrl = deploymentUrl;
        current.deploymentUrl = deploymentUrl;
        current.error = null;
        delete current.deploymentStartedAt;
      });
      await projectStore.addAction(project.id, "Deployment completed on Vercel", "success", deploymentUrl);
      return { done: true as const, success: true as const, deploymentUrl };
    }

    if (isTerminalFailure(status)) {
      throw new AppError("Vercel deployment failed.", {
        statusCode: 502,
        code: "VERCEL_DEPLOYMENT_FAILED",
        details: [
          `Deployment status: ${status}`,
          deployment.errorMessage ? `Error: ${deployment.errorMessage}` : null,
          deployment.inspectorUrl ? `Inspector: ${deployment.inspectorUrl}` : null
        ].filter(Boolean).join("\n"),
        setupInstructions: [
          "Open the Vercel inspector URL from the deployment timeline.",
          "Check whether npm install or npm run build failed.",
          "Use Edit Mission to fix the generated project and deploy again."
        ]
      });
    }

    return { done: false as const };
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

  private async api<T>(path: string, options: VercelApiOptions = {}): Promise<T> {
    const response = await fetch(`${apiBase}${path}${teamQuery(path)}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${config.vercelToken}`,
        ...(options.body ? { "Content-Type": "application/json" } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: options.signal
    });

    const text = await response.text();
    const payload = text ? safeJson(text) : null;

    if (!response.ok) {
      throw new AppError(readVercelMessage(payload, response.statusText), {
        statusCode: response.status,
        code: `VERCEL_${response.status}`,
        details: text,
        setupInstructions: response.status === 401 || response.status === 403 ? setupHelp.vercel : undefined
      });
    }

    return payload as T;
  }
}

function teamQuery(path: string) {
  const params = new URLSearchParams();
  if (config.vercelTeamId) params.set("teamId", config.vercelTeamId);
  if (config.vercelTeamSlug) params.set("slug", config.vercelTeamSlug);
  const separator = path.includes("?") ? "&" : "?";
  const query = params.toString();
  return query ? separator + query : "";
}

function vercelProjectName(project: Project) {
  const parts = [project.githubOwner, project.githubRepo ?? project.name].filter(Boolean).join("-");
  return slugify(`deployrocket-${parts}`, "deployrocket-project").slice(0, 100);
}

function toPublicUrl(url?: string) {
  if (!url) return undefined;
  return url.startsWith("http://") || url.startsWith("https://") ? url : `https://${url}`;
}

function isTerminalFailure(status: string) {
  return status === "ERROR" || status === "CANCELED";
}

function safeJson(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function readVercelMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object") {
    if ("error" in payload) {
      const error = (payload as { error?: unknown }).error;
      if (error && typeof error === "object" && "message" in error) {
        return String((error as { message: unknown }).message);
      }
      if (typeof error === "string") return error;
    }
    if ("message" in payload) return String((payload as { message: unknown }).message);
  }
  return fallback || "Vercel API request failed.";
}

export const vercelDeployManager = new VercelDeployManager();
