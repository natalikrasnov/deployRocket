import type { Project, SetupStatus } from "@shared/types";

interface ApiErrorPayload {
  error?: {
    message?: string;
    code?: string;
    details?: string;
    setupInstructions?: string[];
  };
}

export class ApiError extends Error {
  readonly code?: string;
  readonly details?: string;
  readonly setupInstructions?: string[];
  readonly status: number;

  constructor(status: number, payload: ApiErrorPayload) {
    super(payload.error?.message ?? "Request failed");
    this.name = "ApiError";
    this.status = status;
    this.code = payload.error?.code;
    this.details = payload.error?.details;
    this.setupInstructions = payload.error?.setupInstructions;
  }
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...options.headers
    }
  });

  if (!response.ok) {
    let payload: ApiErrorPayload = {};
    try {
      payload = (await response.json()) as ApiErrorPayload;
    } catch {
      payload = { error: { message: response.statusText } };
    }
    throw new ApiError(response.status, payload);
  }

  return (await response.json()) as T;
}

function buildProjectForm(text: string, images: File[], extra: Record<string, string> = {}) {
  const form = new FormData();
  form.set("text", text);
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  for (const image of images) form.append("images", image);
  return form;
}

export const api = {
  getSetup: () => request<SetupStatus>("/api/setup"),
  listProjects: () => request<Project[]>("/api/projects"),
  getProject: (id: string) => request<Project>(`/api/projects/${id}`),
  createProject: (text: string, images: File[]) =>
    request<Project>("/api/projects", {
      method: "POST",
      body: buildProjectForm(text, images)
    }),
  editProject: (id: string, text: string, images: File[], forceStop: boolean) =>
    request<Project>(`/api/projects/${id}/edit`, {
      method: "POST",
      body: buildProjectForm(text, images, { forceStop: String(forceStop) })
    }),
  stopProject: (id: string) =>
    request<Project>(`/api/projects/${id}/stop`, {
      method: "POST",
      body: JSON.stringify({})
    }),
  refreshProject: (id: string) =>
    request<Project>(`/api/projects/${id}/refresh`, {
      method: "POST",
      body: JSON.stringify({})
    }),
  disconnectGithub: () =>
    request<SetupStatus>("/api/auth/github/disconnect", {
      method: "POST",
      body: JSON.stringify({})
    })
};
