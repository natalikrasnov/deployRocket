import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Circle,
  ExternalLink,
  Github,
  ImageUp,
  LayoutDashboard,
  Loader2,
  Mic,
  PauseCircle,
  Plus,
  RefreshCw,
  Rocket,
  Send,
  Settings,
  Square,
  Unplug,
  Wand2,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, apiBaseUrl, apiUrl, ApiError, isStaticFrontendWithoutApiBase } from "./api";
import type { ActionLevel, Project, ProjectStatus, SetupStatus } from "@shared/types";

type View =
  | { name: "dashboard" }
  | { name: "new" }
  | { name: "detail"; projectId: string }
  | { name: "edit"; projectId: string };

type SpeechRecognitionCtor = new () => SpeechRecognition;

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}

interface SpeechRecognitionEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

const runningStatuses: ProjectStatus[] = [
  "PROCESSING_INPUT",
  "GENERATING_PROMPT",
  "SENDING_TO_CODEX",
  "CODEX_WORKING",
  "SAVING_TO_GITHUB",
  "DEPLOYING"
];

const statusTone: Record<ProjectStatus, string> = {
  IDLE: "border-zinc-700 bg-zinc-900 text-zinc-300",
  PROCESSING_INPUT: "border-purple-500/45 bg-purple-500/10 text-purple-100",
  GENERATING_PROMPT: "border-fuchsia-400/45 bg-fuchsia-400/10 text-fuchsia-100",
  SENDING_TO_CODEX: "border-cyan-400/45 bg-cyan-400/10 text-cyan-100",
  CODEX_WORKING: "border-teal-400/45 bg-teal-400/10 text-teal-100",
  SAVING_TO_GITHUB: "border-blue-500/40 bg-blue-500/10 text-blue-200",
  DEPLOYING: "border-emerald-400/45 bg-emerald-400/10 text-emerald-100",
  LIVE: "border-emerald-400/45 bg-emerald-400/10 text-emerald-100",
  FAILED: "border-rose-500/50 bg-rose-500/10 text-rose-200",
  STOPPED: "border-zinc-500/50 bg-zinc-500/10 text-zinc-200"
};

const actionTone: Record<ActionLevel, { dot: string; card: string; icon: "check" | "alert" | "circle" }> = {
  info: {
    dot: "border-cyan-400/35 bg-cyan-400/10 text-cyan-300",
    card: "border-white/5 bg-white/[0.02]",
    icon: "circle"
  },
  success: {
    dot: "border-emerald-400/35 bg-emerald-400/10 text-emerald-300",
    card: "border-emerald-400/10 bg-emerald-400/[0.03]",
    icon: "check"
  },
  warning: {
    dot: "border-amber-300/35 bg-amber-300/10 text-amber-200",
    card: "border-amber-300/15 bg-amber-300/[0.04]",
    icon: "alert"
  },
  error: {
    dot: "border-rose-400/40 bg-rose-400/10 text-rose-200",
    card: "border-rose-400/25 bg-rose-400/[0.06]",
    icon: "alert"
  }
};

function isRunning(project?: Project | null) {
  return Boolean(project && runningStatuses.includes(project.status));
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function statusLabel(status: ProjectStatus) {
  return status.replaceAll("_", " ");
}

export default function App() {
  const [view, setView] = useState<View>({ name: "dashboard" });
  const [projects, setProjects] = useState<Project[]>([]);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [confirmEdit, setConfirmEdit] = useState<Project | null>(null);
  const [popup, setPopup] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const selectedProject = useMemo(() => {
    if (view.name !== "detail" && view.name !== "edit") return null;
    return projects.find((project) => project.id === view.projectId) ?? null;
  }, [projects, view]);

  const refreshAll = useCallback(async () => {
    const nextSetup = await api.getSetup();
    setSetup(nextSetup);
    setSetupError(null);
    setProjects(nextSetup.githubConnected ? await api.listProjects() : []);
  }, []);

  useEffect(() => {
    refreshAll()
      .catch((error) => {
        const message = readError(error);
        setSetupError(message);
        setNotice(message);
      })
      .finally(() => setLoading(false));
  }, [refreshAll]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const github = params.get("github");
    if (github === "connected") {
      setPopup({ type: "success", message: "Successfully connected to GitHub." });
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (github === "error") {
      const code = params.get("code") || "Unknown error";
      setPopup({ type: "error", message: `GitHub connection failed: ${code}` });
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  useEffect(() => {
    let inFlight = false;
    let cancelled = false;

    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        if (view.name === "detail" || view.name === "edit") {
          const currentProject = await api.getProject(view.projectId);
          const project = isRunning(currentProject)
            ? await api.runProject(view.projectId)
            : currentProject;
          if (!cancelled) setProjects((current) => upsertProject(current, project));
        } else {
          const nextSetup = await api.getSetup();
          if (!cancelled) setSetup(nextSetup);
          const nextProjects = nextSetup.githubConnected ? await api.listProjects() : [];
          if (!cancelled) setProjects(nextProjects);
        }
      } catch (error) {
        if (!cancelled) {
          const message = readError(error);
          if (view.name === "dashboard" || view.name === "new") setSetupError(message);
          setNotice(message);
        }
      } finally {
        inFlight = false;
      }
    };

    void load();
    const interval = setInterval(load, view.name === "dashboard" ? 5000 : 2200);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [view]);

  const openProject = (project: Project) => {
    setView({ name: "detail", projectId: project.id });
  };

  const handleCreate = async (text: string, images: File[]) => {
    const project = await api.createProject(text, images);
    setProjects((current) => upsertProject(current, project));
    setView({ name: "detail", projectId: project.id });
  };

  const handleEditSubmit = async (text: string, images: File[]) => {
    if (!selectedProject) return;
    const project = await api.editProject(selectedProject.id, text, images, false);
    setProjects((current) => upsertProject(current, project));
    setView({ name: "detail", projectId: project.id });
  };

  const beginEdit = (project: Project) => {
    if (isRunning(project)) {
      setConfirmEdit(project);
      return;
    }
    setView({ name: "edit", projectId: project.id });
  };

  const stopAndEdit = async () => {
    if (!confirmEdit) return;
    const stopped = await api.stopProject(confirmEdit.id);
    setProjects((current) => upsertProject(current, stopped));
    setView({ name: "edit", projectId: confirmEdit.id });
    setConfirmEdit(null);
  };

  const stopProject = async (project: Project) => {
    const stopped = await api.stopProject(project.id);
    setProjects((current) => upsertProject(current, stopped));
  };

  const refreshProject = async (project: Project) => {
    const refreshed = await api.refreshProject(project.id);
    setProjects((current) => upsertProject(current, refreshed));
  };

  const continueProject = async (project: Project) => {
    try {
      const continued = await api.continueProject(project.id);
      setProjects((current) => upsertProject(current, continued));
      setView({ name: "detail", projectId: continued.id });
    } catch (error) {
      setNotice(readError(error));
    }
  };

  return (
    <main className="flex flex-col md:flex-row h-screen w-screen overflow-hidden bg-[#05080f] text-zinc-100 relative">
      <div className="absolute inset-0 z-0 bg-[linear-gradient(155deg,rgba(5,8,15,0.99)_0%,rgba(10,11,24,0.98)_45%,rgba(15,23,42,0.96)_100%)]" />
      
      <Sidebar view={view} setView={setView} />
      
      <div className="flex-1 flex flex-col relative z-10 overflow-hidden">
        <AppHeader
          view={view}
          onBack={() => setView({ name: "dashboard" })}
          onNew={() => setView({ name: "new" })}
        />

        <div className="flex-1 overflow-y-auto px-4 py-4 pb-24 md:pb-8 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-5xl flex flex-col min-h-full">
            {notice ? <Notice message={notice} onClose={() => setNotice(null)} /> : null}
            {setup ? (
              <SetupBanner
                setup={setup}
                onDisconnect={async () => {
                  setSetup(await api.disconnectGithub());
                  await refreshAll();
                }}
              />
            ) : setupError ? (
              <ApiConnectionBanner message={setupError} />
            ) : null}

            <section className="flex-1 pb-8 pt-4">
              {loading ? (
                <LoadingScreen />
              ) : view.name === "dashboard" ? (
                <Dashboard projects={projects} onOpen={openProject} />
              ) : view.name === "new" ? (
                <ProjectInputScreen mode="create" onSubmit={handleCreate} onCancel={() => setView({ name: "dashboard" })} />
              ) : view.name === "edit" && selectedProject ? (
                <ProjectInputScreen
                  mode="edit"
                  project={selectedProject}
                  onSubmit={handleEditSubmit}
                  onCancel={() => setView({ name: "detail", projectId: selectedProject.id })}
                />
              ) : selectedProject ? (
                <ProjectDetails
                  project={selectedProject}
                  onEdit={() => beginEdit(selectedProject)}
                  onStop={() => stopProject(selectedProject)}
                  onRefresh={() => refreshProject(selectedProject)}
                  onContinue={() => continueProject(selectedProject)}
                />
              ) : (
                <EmptyProject onBack={() => setView({ name: "dashboard" })} />
              )}
            </section>
          </div>
        </div>
      </div>

      {confirmEdit ? (
        <ConfirmDialog
          project={confirmEdit}
          onCancel={() => setConfirmEdit(null)}
          onConfirm={stopAndEdit}
        />
      ) : null}

      {popup ? (
        <Popup
          type={popup.type}
          message={popup.message}
          onClose={() => setPopup(null)}
        />
      ) : null}

      <BottomNav view={view} setView={setView} />
    </main>
  );
}

function Sidebar({ view, setView }: { view: View; setView: (v: View) => void }) {
  const isDashboard = view.name === "dashboard";
  const isNew = view.name === "new";
  
  return (
    <aside className="hidden md:flex relative z-20 w-64 shrink-0 flex-col border-r border-white/5 bg-white/[0.01] backdrop-blur-xl p-4">
      <div className="flex items-center gap-3 mb-8 px-2">
         <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-cyan-400/30 bg-cyan-400/10 text-cyan-300 shadow-glow-cyan">
           <Rocket size={18} />
         </div>
         <span className="text-lg font-bold tracking-wide text-white">deployRocket</span>
      </div>

      <nav className="flex-1 space-y-2">
        <button
          onClick={() => setView({ name: "dashboard" })}
          className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
            isDashboard
              ? "bg-cyan-500/15 text-cyan-300 shadow-[inset_2px_0_0_0_rgba(34,211,238,1)]" 
              : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
          }`}
        >
          <LayoutDashboard size={20} />
          Dashboard
        </button>
        <button
          onClick={() => setView({ name: "new" })}
          className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
            isNew
              ? "bg-cyan-500/15 text-cyan-300 shadow-[inset_2px_0_0_0_rgba(34,211,238,1)]" 
              : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
          }`}
        >
          <Plus size={20} />
          Launch Request
        </button>
      </nav>

      <div className="border-t border-white/10 pt-4 mt-auto">
        <button className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200">
          <Settings size={20} />
          Settings
        </button>
      </div>
    </aside>
  );
}

function BottomNav({ view, setView }: { view: View; setView: (v: View) => void }) {
  const isDashboard = view.name === "dashboard";
  const isNew = view.name === "new";
  
  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 flex items-center justify-around border-t border-white/5 bg-[#05080f]/80 backdrop-blur-xl px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
      <button
        onClick={() => setView({ name: "dashboard" })}
        className={`flex flex-col items-center gap-1 transition ${isDashboard ? "text-cyan-400" : "text-zinc-500 hover:text-zinc-300"}`}
      >
        <LayoutDashboard size={20} />
        <span className="text-[10px] font-medium tracking-wide uppercase">Dashboard</span>
      </button>
      <button
        onClick={() => setView({ name: "new" })}
        className={`flex flex-col items-center gap-1 transition ${isNew ? "text-cyan-400" : "text-zinc-500 hover:text-zinc-300"}`}
      >
        <Plus size={20} />
        <span className="text-[10px] font-medium tracking-wide uppercase">Launch</span>
      </button>
      <button className="flex flex-col items-center gap-1 text-zinc-500 transition hover:text-zinc-300">
        <Settings size={20} />
        <span className="text-[10px] font-medium tracking-wide uppercase">Settings</span>
      </button>
    </nav>
  );
}



function AppHeader({
  view,
  onBack,
  onNew
}: {
  view: View;
  onBack: () => void;
  onNew: () => void;
}) {
  const showBack = view.name !== "dashboard";
  return (
    <header className="sticky top-0 z-20 border-b border-white/5 bg-[#05080f]/50 px-4 py-3 backdrop-blur-xl sm:px-6 lg:px-8 shrink-0">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {showBack ? (
            <IconButton label="Back" onClick={onBack}>
              <ArrowLeft size={19} />
            </IconButton>
          ) : (
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold text-white">Dashboard</h1>
            </div>
          )}
        </div>
        <button
          className="inline-flex h-10 items-center gap-2 rounded-lg bg-cyan-400 px-3 text-sm font-semibold text-zinc-950 shadow-glow-cyan transition hover:bg-cyan-300"
          onClick={onNew}
          type="button"
        >
          <Plus size={18} />
          <span>New</span>
        </button>
      </div>
    </header>
  );
}

function SetupBanner({
  setup,
  onDisconnect
}: {
  setup: SetupStatus;
  onDisconnect: () => Promise<void>;
}) {
  if (setup.openaiConfigured && setup.githubOAuthConfigured && setup.githubConnected) {
    return (
      <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-100">
        <span className="truncate">
          GitHub connected{setup.githubUser ? ` as ${setup.githubUser.login}` : ""}
        </span>
        <button
          type="button"
          onClick={onDisconnect}
          className="inline-flex h-8 items-center gap-1 rounded-lg border border-emerald-300/25 px-2 text-xs text-emerald-100"
        >
          <Unplug size={14} />
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-purple-400/30 bg-purple-400/10 p-3 text-sm text-purple-50 backdrop-blur-md">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 shrink-0 text-purple-300" size={18} />
        <div className="min-w-0 flex-1">
          <p className="font-medium">Setup required</p>
          <p className="mt-1 text-purple-100/80">{setup.missing.join(", ")}</p>
          <p className="mt-2 break-all text-xs text-purple-100/70">Callback: {setup.callbackUrl}</p>
        </div>
      </div>
      {setup.githubOAuthConfigured ? (
        <a
          href={apiUrl("/auth/github")}
          className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg bg-purple-300 px-3 text-sm font-semibold text-zinc-950 shadow-glow-purple"
        >
          <Github size={16} />
          Connect GitHub
        </a>
      ) : null}
    </div>
  );
}

function ApiConnectionBanner({ message }: { message: string }) {
  const missingApiBase = isStaticFrontendWithoutApiBase();
  return (
    <div className="mt-4 rounded-lg border border-amber-300/35 bg-amber-300/10 p-3 text-sm text-amber-50 backdrop-blur-md">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 shrink-0 text-amber-200" size={18} />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{missingApiBase ? "Backend API URL missing" : "Cannot reach deployRocket API"}</p>
          <p className="mt-1 text-amber-50/80">{message}</p>
          {missingApiBase ? (
            <p className="mt-2 text-xs leading-5 text-amber-50/70">
              GitHub Pages is static, so it cannot run OAuth or API routes itself. Set the Actions variable
              <span className="mx-1 rounded bg-black/20 px-1.5 py-0.5 font-mono">VITE_API_BASE_URL</span>
              to your hosted backend origin, then rerun the Pages workflow.
            </p>
          ) : (
            <p className="mt-2 break-all text-xs text-amber-50/70">API base: {apiBaseUrl || window.location.origin}</p>
          )}
        </div>
      </div>
      {!missingApiBase ? (
        <a
          href={apiUrl("/auth/github")}
          className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg bg-amber-200 px-3 text-sm font-semibold text-zinc-950"
        >
          <Github size={16} />
          Connect GitHub
        </a>
      ) : null}
    </div>
  );
}

function Dashboard({
  projects,
  onOpen
}: {
  projects: Project[];
  onOpen: (project: Project) => void;
}) {
  if (projects.length === 0) {
    return (
      <div className="flex min-h-[58vh] flex-col items-center justify-center text-center">
        <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-lg border border-cyan-400/20 bg-cyan-400/10 text-cyan-300 backdrop-blur-md">
          <Rocket size={28} />
        </div>
        <h2 className="text-2xl font-semibold text-white">Ready for launch</h2>
        <p className="mt-2 max-w-xs text-sm text-zinc-400">Fuel a project brief and deploy it through Codex, GitHub, and Pages.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {projects.map((project) => (
        <button
          key={project.id}
          className="rounded-lg border border-white/5 bg-white/[0.02] p-4 text-left backdrop-blur-md transition hover:border-cyan-400/45 hover:bg-white/[0.04] hover:shadow-glow-cyan"
          type="button"
          onClick={() => onOpen(project)}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold text-white">{project.name}</h2>
              <p className="mt-1 line-clamp-2 text-sm text-zinc-400">{project.summary}</p>
            </div>
            <StatusPill status={project.status} />
          </div>
          <div className="mt-4 flex items-center justify-between gap-3 text-xs text-zinc-500">
            <span>{formatTime(project.updatedAt)}</span>
            {project.error ? (
              <span className="inline-flex items-center gap-1 text-rose-200">
                <AlertTriangle size={14} />
                Error
              </span>
            ) : null}
          </div>
          {project.githubPagesUrl ? (
            <div className="mt-3 flex items-center gap-2 truncate text-sm text-lime-200">
              <ExternalLink size={15} />
              <span className="truncate">{project.githubPagesUrl}</span>
            </div>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function ProjectInputScreen({
  mode,
  project,
  onSubmit,
  onCancel
}: {
  mode: "create" | "edit";
  project?: Project;
  onSubmit: (text: string, images: File[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const submit = async () => {
    setError(null);
    if (!text.trim() && images.length === 0) {
      setError("Project input cannot be empty.");
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit(text, images);
    } catch (submitError) {
      setError(readError(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  const toggleVoice = () => {
    setError(null);
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) {
      setError("Voice input is not supported by this browser.");
      return;
    }

    if (recording) {
      recognitionRef.current?.stop();
      setRecording(false);
      return;
    }

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = navigator.language || "en-US";
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? "")
        .join(" ")
        .trim();
      if (transcript) setText((current) => `${current}${current ? " " : ""}${transcript}`);
    };
    recognition.onerror = (event) => {
      setError(`Voice input failed: ${event.error}`);
      setRecording(false);
    };
    recognition.onend = () => setRecording(false);
    recognitionRef.current = recognition;
    recognition.start();
    setRecording(true);
  };

  return (
    <div className="mx-auto flex h-full min-h-[calc(100vh-10rem)] max-w-3xl flex-col items-center justify-center relative pb-20 md:pb-6">
      <div className="w-full flex flex-col items-center justify-center text-center px-4 pb-8">
         <div className="flex h-16 w-16 items-center justify-center rounded-full border border-cyan-400/20 bg-cyan-400/10 text-cyan-300 shadow-glow-cyan mb-6">
           {mode === "create" ? <Rocket size={32} /> : <Wand2 size={32} />}
         </div>
         <h2 className="text-3xl font-semibold text-white tracking-tight">
           {mode === "create" ? "Initialize Launch Sequence" : "Mission Update"}
         </h2>
         <p className="mt-3 text-sm leading-relaxed text-zinc-400 max-w-md">
           {mode === "create" 
             ? "Describe your project requirements. The AI will chart the architecture, setup the repository, and deploy the initial version."
             : `Adjust the mission parameters for ${project?.name}.`}
         </p>
      </div>

      <div className="w-full px-2 mt-4 max-w-2xl">
        {mode === "edit" ? (
          <div className="flex justify-between items-center mb-3 px-1">
             <span className="text-xs font-medium text-cyan-400 uppercase tracking-widest">{project?.name}</span>
             <button onClick={onCancel} className="text-xs text-zinc-500 hover:text-zinc-300 transition">Cancel Update</button>
          </div>
        ) : null}

        <div className="relative flex flex-col rounded-3xl border border-white/5 bg-[#0A0D15]/90 backdrop-blur-2xl shadow-[0_0_40px_rgba(34,211,238,0.05)] focus-within:border-cyan-400/40 focus-within:shadow-glow-cyan transition-all duration-500">
           
           {images.length > 0 ? (
              <div className="flex gap-2 p-3 pb-0 overflow-x-auto">
                {images.map((image, index) => (
                  <div
                    key={`${image.name}-${index}`}
                    className="flex shrink-0 items-center gap-2 rounded-lg border border-white/10 bg-zinc-900/50 px-2 py-1 text-xs text-zinc-300"
                  >
                    <ImageUp size={14} />
                    <span className="max-w-32 truncate">{image.name}</span>
                    <button
                      type="button"
                      onClick={() => setImages((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                      className="text-zinc-500 hover:text-white"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
           ) : null}

           <div className="flex items-end gap-2 p-2">
             <div className="flex items-center gap-1 pb-1 pl-1 shrink-0">
               <IconButton label={recording ? "Stop voice" : "Voice input"} onClick={toggleVoice} active={recording}>
                 {recording ? <Square size={20} className="text-rose-400" /> : <Mic size={20} />}
               </IconButton>
               <IconButton label="Upload image" onClick={() => fileRef.current?.click()}>
                 <ImageUp size={20} />
               </IconButton>
             </div>
             
             <textarea
               value={text}
               onChange={(event) => setText(event.target.value)}
               className="max-h-[30vh] min-h-[44px] flex-1 resize-none bg-transparent py-3 px-2 text-[15px] leading-relaxed text-white placeholder:text-zinc-500 outline-none"
               placeholder={mode === "create" ? "Launch a project that..." : "Adjust the mission..."}
               rows={text.split('\n').length > 1 ? Math.min(text.split('\n').length, 5) : 1}
               onKeyDown={(e) => {
                 if (e.key === 'Enter' && !e.shiftKey) {
                   e.preventDefault();
                   if (!submitting) submit();
                 }
               }}
             />

             <div className="pb-1 pr-1 shrink-0">
               <button
                 type="button"
                 onClick={submit}
                 disabled={submitting}
                 className="flex h-10 w-10 items-center justify-center rounded-2xl bg-cyan-400 text-cyan-950 transition-all hover:bg-cyan-300 disabled:opacity-50 disabled:hover:bg-cyan-400 shadow-[0_0_15px_rgba(34,211,238,0.4)]"
               >
                 {submitting ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} className="ml-0.5" />}
               </button>
             </div>
           </div>
        </div>
        
        {error ? <p className="mt-3 text-center text-xs text-rose-400">{error}</p> : null}
        
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => {
            setImages(Array.from(event.target.files ?? []).slice(0, 4));
            event.target.value = "";
          }}
        />
      </div>
    </div>
  );
}

function ProjectDetails({
  project,
  onEdit,
  onStop,
  onRefresh,
  onContinue
}: {
  project: Project;
  onEdit: () => void;
  onStop: () => void;
  onRefresh: () => void;
  onContinue: () => Promise<void> | void;
}) {
  const [continueBusy, setContinueBusy] = useState(false);

  const handleContinue = async () => {
    setContinueBusy(true);
    try {
      await onContinue();
    } finally {
      setContinueBusy(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl gap-6 flex-col lg:flex-row">
      <div className="flex-1 flex flex-col gap-4">
        {/* Left Column: Header and Logs */}
        <div className="rounded-lg border border-white/5 bg-white/[0.02] backdrop-blur-md p-5 shadow-2xl">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-2xl font-semibold text-white">{project.name}</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-400">{project.summary}</p>
            </div>
            <StatusPill status={project.status} />
          </div>
        </div>

        {project.error ? <ErrorPanel project={project} /> : null}

        <div className="rounded-lg border border-white/5 bg-white/[0.02] backdrop-blur-md p-5 shadow-xl flex-1">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-lg font-semibold text-white">Deployment Timeline</h3>
            <span className="text-xs text-zinc-500">{project.actions.length} events</span>
          </div>
          <div className="relative space-y-3 pl-9 before:absolute before:left-3 before:top-2 before:bottom-2 before:w-px before:bg-gradient-to-b before:from-transparent before:via-white/10 before:to-transparent">
            {[...project.actions].reverse().map((action) => {
              const tone = actionTone[action.level];
              return (
                <div key={action.id} className="relative">
                  <div className={`absolute -left-9 top-3 flex h-6 w-6 items-center justify-center rounded-full border shadow-lg ${tone.dot}`}>
                    {tone.icon === "check" ? <CheckCircle2 size={14} /> : tone.icon === "alert" ? <AlertTriangle size={13} /> : <Circle size={9} />}
                  </div>
                  <div className={`rounded-lg border p-3 backdrop-blur-sm ${tone.card}`}>
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                      <p className="min-w-0 text-sm font-medium leading-5 text-zinc-100">{action.message}</p>
                      <span className="shrink-0 text-xs text-zinc-500">{formatTime(action.at)}</span>
                    </div>
                    {action.details ? (
                      <p className="mt-2 max-h-28 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-white/5 bg-black/15 p-2 text-xs leading-5 text-zinc-400">
                        {action.details}
                      </p>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="w-full lg:w-80 shrink-0 flex flex-col gap-4">
        {/* Right Column: Active Step, Links, Actions */}
        <div className="rounded-lg border border-cyan-400/20 bg-cyan-950/20 p-4 backdrop-blur-sm shadow-glow-cyan">
          <p className="text-xs uppercase tracking-[0.18em] text-cyan-500 mb-2">Current Status</p>
          <div className="flex items-center gap-2 text-cyan-100">
            {isRunning(project) ? <Loader2 className="animate-spin text-cyan-300" size={18} /> : <Circle size={14} />}
            <span className="font-semibold">{project.currentStep}</span>
          </div>
        </div>

        <div className="rounded-lg border border-white/5 bg-white/[0.02] backdrop-blur-md p-4 shadow-2xl">
          <p className="text-xs uppercase tracking-[0.18em] text-zinc-500 mb-3">Project Links</p>
          <div className="flex flex-col gap-2">
            {project.githubRepoUrl ? (
              <ExternalAnchor href={project.githubRepoUrl} icon={<Github size={16} />} label="Repository" />
            ) : null}
            {project.githubPagesUrl ? (
              <ExternalAnchor href={project.githubPagesUrl} icon={<ExternalLink size={16} />} label="Live Site" />
            ) : null}
            {!project.githubRepoUrl && !project.githubPagesUrl ? (
              <p className="text-sm text-zinc-500">No links generated yet.</p>
            ) : null}
          </div>
        </div>

        <div className="rounded-lg border border-white/5 bg-white/[0.02] backdrop-blur-md p-4 shadow-2xl">
           <p className="text-xs uppercase tracking-[0.18em] text-zinc-500 mb-3">Controls</p>
           <div className="flex flex-col gap-2">
             <button
               type="button"
               onClick={onRefresh}
               className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-white/5 px-3 text-sm text-zinc-200 hover:bg-white/5 transition"
             >
               <RefreshCw size={16} />
               Refresh Status
             </button>
             {project.status === "FAILED" ? (
               <button
                 type="button"
                 onClick={handleContinue}
                 disabled={continueBusy}
                 className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-emerald-300/30 bg-emerald-400/15 px-3 text-sm font-semibold text-emerald-100 shadow-[0_0_18px_rgba(52,211,153,0.16)] transition hover:bg-emerald-400/25 disabled:cursor-not-allowed disabled:opacity-60"
               >
                 {continueBusy ? <Loader2 className="animate-spin" size={16} /> : <Rocket size={16} />}
                 Continue Mission
               </button>
             ) : null}
             <button
               type="button"
               onClick={onEdit}
               className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-cyan-400 px-3 text-sm font-semibold text-zinc-950 shadow-glow-cyan transition hover:bg-cyan-300"
             >
               <Wand2 size={16} />
               Edit Mission
             </button>
             {isRunning(project) ? (
               <button
                 type="button"
                 onClick={onStop}
                 className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-purple-400/30 bg-purple-500/10 px-3 text-sm text-purple-200 hover:bg-purple-500/20 transition"
               >
                 <PauseCircle size={16} />
                 Stop Process
               </button>
             ) : null}
           </div>
        </div>
      </div>
    </div>
  );
}

function ErrorPanel({ project }: { project: Project }) {
  if (!project.error) return null;
  return (
    <div className="mt-4 rounded-lg border border-rose-400/35 bg-rose-500/10 p-4 text-rose-50">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 shrink-0" size={18} />
        <div className="min-w-0">
          <h3 className="font-semibold">Error</h3>
          <p className="mt-1 text-sm text-rose-100">{project.error.message}</p>
          {project.error.code ? <p className="mt-2 text-xs text-rose-100/70">{project.error.code}</p> : null}
          {project.error.setupInstructions?.length ? (
            <ul className="mt-3 space-y-1 text-sm text-rose-50/90">
              {project.error.setupInstructions.map((item) => (
                <li key={item}>- {item}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ConfirmDialog({
  project,
  onCancel,
  onConfirm
}: {
  project: Project;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/70 p-4 backdrop-blur-sm sm:items-center sm:justify-center">
      <div className="w-full max-w-md rounded-lg border border-white/10 bg-zinc-950 p-4 shadow-2xl">
        <h3 className="text-lg font-semibold text-white">{project.name}</h3>
        <p className="mt-2 text-sm leading-6 text-zinc-300">
          The project is currently running. Editing will stop the current process.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-10 rounded-lg border border-white/10 px-3 text-sm text-zinc-300"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={async () => {
              setBusy(true);
              await onConfirm();
            }}
            disabled={busy}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-cyan-400 px-3 text-sm font-semibold text-zinc-950 shadow-glow-cyan disabled:opacity-60"
          >
            {busy ? <Loader2 className="animate-spin" size={16} /> : <PauseCircle size={16} />}
            Stop and Continue
          </button>
        </div>
      </div>
    </div>
  );
}

function Popup({ type, message, onClose }: { type: "success" | "error"; message: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="relative flex w-full max-w-sm flex-col items-center rounded-lg border border-white/10 bg-zinc-950 p-6 text-center shadow-2xl">
        <button onClick={onClose} className="absolute right-3 top-3 text-zinc-500 transition hover:text-white">
          <X size={18} />
        </button>
        <div
          className={`mb-4 flex h-14 w-14 items-center justify-center rounded-full border ${
            type === "success"
              ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-400 shadow-[0_0_15px_rgba(52,211,153,0.3)]"
              : "border-rose-400/20 bg-rose-400/10 text-rose-400 shadow-[0_0_15px_rgba(244,63,94,0.3)]"
          }`}
        >
          {type === "success" ? <CheckCircle2 size={28} /> : <AlertTriangle size={28} />}
        </div>
        <h3 className="mb-2 text-xl font-semibold text-white">{type === "success" ? "Success" : "Error"}</h3>
        <p className="text-sm leading-relaxed text-zinc-300">{message}</p>
        <button
          type="button"
          onClick={onClose}
          className={`mt-6 h-10 w-full rounded-lg font-semibold transition ${
            type === "success"
              ? "bg-emerald-400 text-emerald-950 shadow-[0_0_15px_rgba(52,211,153,0.4)] hover:bg-emerald-300"
              : "bg-rose-400 text-rose-950 shadow-[0_0_15px_rgba(244,63,94,0.4)] hover:bg-rose-300"
          }`}
        >
          {type === "success" ? "Continue" : "Dismiss"}
        </button>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: ProjectStatus }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-lg border px-2 py-1 text-[11px] font-semibold uppercase ${statusTone[status]}`}
    >
      {statusLabel(status)}
    </span>
  );
}

function IconButton({
  label,
  children,
  onClick,
  active = false
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      type="button"
      onClick={onClick}
      className={`flex h-10 w-10 items-center justify-center rounded-lg border transition ${
        active
          ? "border-cyan-400 bg-cyan-400 text-zinc-950 shadow-glow-cyan"
          : "border-white/10 bg-white/[0.05] text-zinc-200 hover:border-cyan-400/45 hover:shadow-glow-cyan"
      }`}
    >
      {children}
    </button>
  );
}

function ExternalAnchor({
  href,
  icon,
  label
}: {
  href: string;
  icon: ReactNode;
  label: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex h-11 min-w-0 items-center gap-2 rounded-lg border border-white/10 bg-zinc-950/60 px-3 text-sm text-zinc-100"
    >
      {icon}
      <span className="truncate">{label}</span>
      <ExternalLink className="ml-auto shrink-0 text-zinc-500" size={14} />
    </a>
  );
}

function Notice({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="mt-4 flex items-start justify-between gap-3 rounded-lg border border-rose-400/35 bg-rose-500/10 p-3 text-sm text-rose-50">
      <span>{message}</span>
      <button type="button" onClick={onClose} aria-label="Dismiss" className="text-rose-100">
        <X size={16} />
      </button>
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center text-cyan-100">
      <Loader2 className="animate-spin" size={28} />
    </div>
  );
}

function EmptyProject({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center text-center">
      <AlertTriangle className="text-purple-200" size={30} />
      <p className="mt-3 text-zinc-300">Project not found.</p>
      <button
        type="button"
        onClick={onBack}
        className="mt-4 h-10 rounded-lg border border-white/10 px-3 text-sm text-zinc-200"
      >
        Back
      </button>
    </div>
  );
}

function upsertProject(projects: Project[], project: Project | null) {
  if (!project) return projects;
  const exists = projects.some((item) => item.id === project.id);
  const next = exists
    ? projects.map((item) => (item.id === project.id ? project : item))
    : [project, ...projects];
  return [...next].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function readError(error: unknown) {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}
