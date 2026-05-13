import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Circle,
  ExternalLink,
  Github,
  ImageUp,
  Loader2,
  Mic,
  PauseCircle,
  Plus,
  RefreshCw,
  Rocket,
  Send,
  Square,
  Unplug,
  Wand2,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, ApiError } from "./api";
import type { Project, ProjectStatus, SetupStatus } from "@shared/types";

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
  PROCESSING_INPUT: "border-orange-500/45 bg-orange-500/10 text-orange-100",
  GENERATING_PROMPT: "border-cyan-400/45 bg-cyan-400/10 text-cyan-100",
  SENDING_TO_CODEX: "border-blue-400/45 bg-blue-400/10 text-blue-100",
  CODEX_WORKING: "border-violet-400/45 bg-violet-400/10 text-violet-100",
  SAVING_TO_GITHUB: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  DEPLOYING: "border-orange-400/45 bg-orange-400/10 text-orange-100",
  LIVE: "border-emerald-400/45 bg-emerald-400/10 text-emerald-100",
  FAILED: "border-rose-500/50 bg-rose-500/10 text-rose-200",
  STOPPED: "border-orange-500/50 bg-orange-500/10 text-orange-200"
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
  const [confirmEdit, setConfirmEdit] = useState<Project | null>(null);

  const selectedProject = useMemo(() => {
    if (view.name !== "detail" && view.name !== "edit") return null;
    return projects.find((project) => project.id === view.projectId) ?? null;
  }, [projects, view]);

  const refreshAll = useCallback(async () => {
    const [nextSetup, nextProjects] = await Promise.all([api.getSetup(), api.listProjects()]);
    setSetup(nextSetup);
    setProjects(nextProjects);
  }, []);

  useEffect(() => {
    refreshAll()
      .catch((error) => setNotice(readError(error)))
      .finally(() => setLoading(false));
  }, [refreshAll]);

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        if (view.name === "detail" || view.name === "edit") {
          const project = await api.getProject(view.projectId);
          setProjects((current) => upsertProject(current, project));
        } else {
          setProjects(await api.listProjects());
        }
      } catch (error) {
        setNotice(readError(error));
      }
    }, view.name === "dashboard" ? 5000 : 2200);

    return () => clearInterval(interval);
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

  return (
    <main className="min-h-screen bg-[#080806] text-zinc-100">
      <div className="fixed inset-0 -z-10 bg-[linear-gradient(155deg,rgba(8,8,6,0.99)_0%,rgba(24,17,10,0.98)_45%,rgba(7,21,24,0.96)_100%)]" />
      <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-4 py-4 sm:px-6 lg:px-8">
        <AppHeader
          view={view}
          onBack={() => setView({ name: "dashboard" })}
          onNew={() => setView({ name: "new" })}
        />

        {notice ? <Notice message={notice} onClose={() => setNotice(null)} /> : null}
        {setup ? (
          <SetupBanner
            setup={setup}
            onDisconnect={async () => {
              setSetup(await api.disconnectGithub());
              await refreshAll();
            }}
          />
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
            />
          ) : (
            <EmptyProject onBack={() => setView({ name: "dashboard" })} />
          )}
        </section>
      </div>

      {confirmEdit ? (
        <ConfirmDialog
          project={confirmEdit}
          onCancel={() => setConfirmEdit(null)}
          onConfirm={stopAndEdit}
        />
      ) : null}
    </main>
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
    <header className="sticky top-0 z-20 -mx-4 border-b border-white/10 bg-[#080806]/88 px-4 py-3 backdrop-blur-xl sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {showBack ? (
            <IconButton label="Back" onClick={onBack}>
              <ArrowLeft size={19} />
            </IconButton>
          ) : (
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-orange-300/35 bg-orange-400/10 text-orange-100">
              <Rocket size={20} />
            </div>
          )}
          <div className="min-w-0">
            <p className="truncate text-sm uppercase tracking-[0.18em] text-orange-200/85">launch control</p>
            <h1 className="truncate text-xl font-semibold text-white">deployRocket</h1>
          </div>
        </div>
        <button
          className="inline-flex h-10 items-center gap-2 rounded-lg bg-orange-300 px-3 text-sm font-semibold text-zinc-950 shadow-glow transition hover:bg-orange-200"
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
    <div className="mt-4 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-50">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 shrink-0 text-amber-200" size={18} />
        <div className="min-w-0 flex-1">
          <p className="font-medium">Setup required</p>
          <p className="mt-1 text-amber-100/80">{setup.missing.join(", ")}</p>
          <p className="mt-2 break-all text-xs text-amber-100/70">Callback: {setup.callbackUrl}</p>
        </div>
      </div>
      {setup.githubOAuthConfigured ? (
        <a
          href="/auth/github"
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
        <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-orange-200">
          <Rocket size={28} />
        </div>
        <h2 className="text-2xl font-semibold text-white">Ready for launch</h2>
        <p className="mt-2 max-w-xs text-sm text-zinc-400">Fuel a project brief and deploy it through Codex, GitHub, and Pages.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {projects.map((project) => (
        <button
          key={project.id}
          className="rounded-lg border border-white/10 bg-white/[0.05] p-4 text-left transition hover:border-orange-300/45 hover:bg-white/[0.07]"
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
    <div className="mx-auto flex min-h-[calc(100vh-9rem)] max-w-2xl flex-col">
      <div className="mb-4">
        <p className="text-sm uppercase tracking-[0.18em] text-orange-200/80">
          {mode === "create" ? "Launch Request" : "Mission Update"}
        </p>
        <h2 className="mt-1 text-2xl font-semibold text-white">
          {mode === "create" ? "Chart the payload" : project?.name}
        </h2>
      </div>

      <div className="flex flex-1 flex-col justify-end rounded-lg border border-white/10 bg-white/[0.045] p-3">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          className="min-h-[42vh] flex-1 resize-none rounded-lg border border-white/10 bg-[#0c0b09]/88 p-4 text-base leading-7 text-white outline-none transition placeholder:text-zinc-600 focus:border-orange-300/60"
          placeholder={mode === "create" ? "Launch a project that..." : "Adjust the mission..."}
        />

        {images.length > 0 ? (
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
            {images.map((image, index) => (
              <div
                key={`${image.name}-${index}`}
                className="flex shrink-0 items-center gap-2 rounded-lg border border-white/10 bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
              >
                <ImageUp size={14} />
                <span className="max-w-32 truncate">{image.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${image.name}`}
                  onClick={() => setImages((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                  className="text-zinc-500 hover:text-white"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {error ? <p className="mt-3 text-sm text-rose-200">{error}</p> : null}

        <div className="mt-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <IconButton label={recording ? "Stop voice" : "Voice input"} onClick={toggleVoice} active={recording}>
              {recording ? <Square size={18} /> : <Mic size={18} />}
            </IconButton>
            <IconButton label="Upload image" onClick={() => fileRef.current?.click()}>
              <ImageUp size={18} />
            </IconButton>
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
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="h-10 rounded-lg border border-white/10 px-3 text-sm text-zinc-300"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={submitting}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-orange-300 px-4 text-sm font-semibold text-zinc-950 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? <Loader2 className="animate-spin" size={17} /> : <Send size={17} />}
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProjectDetails({
  project,
  onEdit,
  onStop,
  onRefresh
}: {
  project: Project;
  onEdit: () => void;
  onStop: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="rounded-lg border border-white/10 bg-white/[0.045] p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-2xl font-semibold text-white">{project.name}</h2>
            <p className="mt-2 text-sm leading-6 text-zinc-400">{project.summary}</p>
          </div>
          <StatusPill status={project.status} />
        </div>

        <div className="mt-5 rounded-lg border border-white/10 bg-[#0c0b09]/70 p-3">
          <p className="text-xs uppercase tracking-[0.18em] text-zinc-500">Active Step</p>
          <div className="mt-2 flex items-center gap-2 text-white">
            {isRunning(project) ? <Loader2 className="animate-spin text-orange-200" size={18} /> : <Circle size={14} />}
            <span>{project.currentStep}</span>
          </div>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {project.githubRepoUrl ? (
            <ExternalAnchor href={project.githubRepoUrl} icon={<Github size={16} />} label="Repository" />
          ) : null}
          {project.githubPagesUrl ? (
            <ExternalAnchor href={project.githubPagesUrl} icon={<ExternalLink size={16} />} label="Live Site" />
          ) : null}
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-white/10 px-3 text-sm text-zinc-200"
          >
            <RefreshCw size={16} />
            Refresh
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-zinc-100 px-3 text-sm font-semibold text-zinc-950"
          >
            <Wand2 size={16} />
            Edit
          </button>
          {isRunning(project) ? (
            <button
              type="button"
              onClick={onStop}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-orange-300/30 bg-orange-400/10 px-3 text-sm text-orange-100"
            >
              <PauseCircle size={16} />
              Stop
            </button>
          ) : null}
        </div>
      </div>

      {project.error ? <ErrorPanel project={project} /> : null}

      <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.045] p-4">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white">Action History</h3>
          <span className="text-xs text-zinc-500">{project.actions.length} events</span>
        </div>
        <div className="space-y-3">
          {[...project.actions].reverse().map((action) => (
            <div key={action.id} className="flex gap-3">
              <div
                className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${
                  action.level === "error"
                    ? "border-rose-300/40 bg-rose-400/10 text-rose-200"
                    : action.level === "success"
                      ? "border-lime-300/35 bg-lime-400/10 text-lime-200"
                      : action.level === "warning"
                        ? "border-amber-300/35 bg-amber-400/10 text-amber-200"
                        : "border-white/10 bg-zinc-900 text-zinc-300"
                }`}
              >
                {action.level === "success" ? <CheckCircle2 size={15} /> : <Circle size={12} />}
              </div>
              <div className="min-w-0 flex-1 border-b border-white/5 pb-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm text-zinc-100">{action.message}</p>
                  <span className="shrink-0 text-xs text-zinc-500">{formatTime(action.at)}</span>
                </div>
                {action.details ? <p className="mt-1 break-all text-xs text-zinc-500">{action.details}</p> : null}
              </div>
            </div>
          ))}
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
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-orange-300 px-3 text-sm font-semibold text-zinc-950 disabled:opacity-60"
          >
            {busy ? <Loader2 className="animate-spin" size={16} /> : <PauseCircle size={16} />}
            Stop and Continue
          </button>
        </div>
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
          ? "border-orange-300 bg-orange-300 text-zinc-950"
          : "border-white/10 bg-white/[0.05] text-zinc-200 hover:border-orange-300/45"
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
    <div className="flex min-h-[50vh] items-center justify-center text-orange-100">
      <Loader2 className="animate-spin" size={28} />
    </div>
  );
}

function EmptyProject({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center text-center">
      <AlertTriangle className="text-amber-200" size={30} />
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
