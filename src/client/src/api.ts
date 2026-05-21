import type { Project, SetupStatus } from "@shared/types";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

export const apiBaseUrl = API_BASE_URL;

export function isStaticFrontendWithoutApiBase() {
  return (
    !API_BASE_URL &&
    typeof window !== "undefined" &&
    window.location.hostname.endsWith("github.io")
  );
}

export function apiUrl(path: string) {
  return API_BASE_URL ? `${API_BASE_URL}${path}` : path;
}

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
  if (isStaticFrontendWithoutApiBase()) {
    throw new ApiError(0, {
      error: {
        message:
          "This static frontend is not connected to the deployRocket API. Set VITE_API_BASE_URL to your hosted backend URL or deploy the frontend and API on the same origin.",
        code: "API_BASE_URL_MISSING",
        setupInstructions: [
          "Deploy the Express API first.",
          "Set VITE_API_BASE_URL to that API origin, for example https://api.example.com.",
          "For a same-origin setup, leave VITE_API_BASE_URL empty."
        ]
      }
    });
  }

  let response: Response;
  try {
    response = await fetch(apiUrl(url), {
      credentials: "include",
      ...options,
      headers: {
        ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        ...options.headers
      }
    });
  } catch (error) {
    throw new ApiError(0, {
      error: {
        message: `Cannot reach the deployRocket API${API_BASE_URL ? ` at ${API_BASE_URL}` : ""}.`,
        code: "API_UNREACHABLE",
        details: error instanceof Error ? error.message : String(error),
        setupInstructions: [
          "Confirm the backend is deployed and reachable over HTTPS.",
          "Confirm FRONTEND_ORIGIN allows this frontend origin.",
          "Confirm VITE_API_BASE_URL points to the backend origin."
        ]
      }
    });
  }

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
  continueProject: (id: string) =>
    request<Project>(`/api/projects/${id}/continue`, {
      method: "POST",
      body: JSON.stringify({})
    }),
  runProject: (id: string) =>
    request<Project>(`/api/projects/${id}/run`, {
      method: "POST",
      body: JSON.stringify({})
    }),
  refreshProject: (id: string) =>
    request<Project>(`/api/projects/${id}/refresh`, {
      method: "POST",
      body: JSON.stringify({})
    }),
  saveOpenAIConnection: (input: { apiKey: string; clientId?: string }) =>
    request<SetupStatus>("/api/settings/openai", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  disconnectOpenAIConnection: () =>
    request<SetupStatus>("/api/settings/openai/disconnect", {
      method: "POST",
      body: JSON.stringify({})
    }),
  activateMockBilling: () =>
    request<SetupStatus>("/api/settings/billing/mock", {
      method: "POST",
      body: JSON.stringify({})
    }),
  disconnectBilling: () =>
    request<SetupStatus>("/api/settings/billing/disconnect", {
      method: "POST",
      body: JSON.stringify({})
    }),
  disconnectGithub: () =>
    request<SetupStatus>("/api/auth/github/disconnect", {
      method: "POST",
      body: JSON.stringify({})
    })
};
