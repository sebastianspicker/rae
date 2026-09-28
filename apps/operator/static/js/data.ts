/** Project, run, and event loading with stale-selection guards. */

import { api, eventStream, setConnection, showError, showToast } from "./api.js";
import { elements, state } from "./state.js";
import { renderEvents, renderRun, renderRuns } from "./render.js";
import { focusSelectedTask } from "./navigation.js";
import { loadWorkflows } from "./workflows.js";
import type { OperatorEvent, OperatorRun } from "./types.js";

interface RunsPage {
  runs: OperatorRun[];
  next_cursor: string | null;
}
interface EventsPage {
  events: OperatorEvent[];
  next_after: number;
  has_more: boolean;
}
interface ProjectsPayload {
  projects: Array<{ id: string; label: string }>;
}
interface ProfilesPayload {
  profiles?: Array<{ id: string; readiness: string; models?: Record<string, string> }>;
}

export async function loadProjects(): Promise<void> {
  const data = await api<ProjectsPayload>("/projects");
  state.projects = data.projects;
  elements["project-select"].replaceChildren(
    ...state.projects.map((project) => new Option(project.label, project.id)),
  );
  state.projectId = state.projects[0]?.id ?? null;
  elements["new-run-button"].disabled = !state.projectId;
  setConnection(
    "connected",
    document.documentElement.dataset.demo === "true" ? "Mock-only demo" : "Local session",
    document.documentElement.dataset.demo === "true"
      ? "No repository access or publish controls"
      : "No publish controls",
  );
  if (state.projectId) {
    await loadExecutionProfiles();
    await loadRuns();
    await loadWorkflows();
  } else {
    elements["runs-loading"].hidden = true;
    renderRuns();
  }
}

export async function loadExecutionProfiles(): Promise<void> {
  if (!state.projectId) return;
  const payload = await api<ProfilesPayload>(
    `/projects/${encodeURIComponent(state.projectId)}/execution-profiles`,
  );
  state.workflowProfiles = payload.profiles ?? [];
  elements["start-execution-profile"].replaceChildren(
    new Option("Runtime default", ""),
    ...state.workflowProfiles.map(
      (profile) =>
        new Option(
          `${profile.id} · ${profile.readiness} · ${Object.entries(profile.models ?? {})
            .map(([tier, model]) => `${tier}: ${model}`)
            .join(", ")}`,
          profile.id,
        ),
    ),
  );
  elements["workflow-proposal-profile"].replaceChildren(
    new Option("Runtime default", ""),
    ...state.workflowProfiles.map(
      (profile) => new Option(`${profile.id} · ${profile.readiness}`, profile.id),
    ),
  );
}

export async function loadRuns(preserveSelection = true): Promise<void> {
  const generation = ++state.runsGeneration;
  const projectId = state.projectId;
  if (!projectId) return;
  elements["runs-loading"].hidden = false;
  elements["runs-empty"].hidden = true;
  const data = await api<RunsPage>(
    `/projects/${encodeURIComponent(projectId)}/runs?limit=100&view=summary`,
  );
  if (!isCurrentRunList(generation, projectId)) return;
  state.runs = data.runs;
  state.runsCursor = data.next_cursor;
  state.runsHasMore = Boolean(data.next_cursor);
  if (!preserveSelection || !state.runs.some((run) => run.id === state.runId)) {
    state.runId = state.runs[0]?.id ?? null;
  }
  if (document.body && !document.body.dataset.runView)
    document.body.dataset.runView = state.runId ? "selected" : "list";
  await selectRun(state.runId);
}

export async function loadMoreRuns(): Promise<void> {
  const generation = state.runsGeneration;
  const projectId = state.projectId;
  const cursor = state.runsCursor;
  if (!projectId || !cursor || state.runsLoadingMore) return;
  state.runsLoadingMore = true;
  renderRuns();
  try {
    const data = await api<RunsPage>(
      `/projects/${encodeURIComponent(projectId)}/runs?limit=100&view=summary&cursor=${encodeURIComponent(cursor)}`,
    );
    if (!isCurrentRunList(generation, projectId) || cursor !== state.runsCursor) return;
    const ids = new Set(state.runs.map((run) => run.id));
    state.runs.push(...data.runs.filter((run) => !ids.has(run.id)));
    state.runsCursor = data.next_cursor;
    state.runsHasMore = Boolean(data.next_cursor);
  } finally {
    if (isCurrentRunList(generation, projectId)) {
      state.runsLoadingMore = false;
      renderRuns();
    }
  }
}

export function isCurrentRunList(generation: number, projectId: string): boolean {
  return generation === state.runsGeneration && projectId === state.projectId;
}

export async function selectRun(runId: string | null): Promise<void> {
  state.runId = runId;
  state.runDetail = null;
  state.detailError = null;
  state.detailLoading = Boolean(runId);
  const generation = ++state.detailGeneration;
  const projectId = state.projectId;
  renderRuns();
  renderRun();
  await Promise.all([loadEvents(), loadRunDetail(generation, projectId, runId)]);
}

async function loadRunDetail(
  generation: number,
  projectId: string | null,
  runId: string | null,
): Promise<void> {
  if (!projectId || !runId) return;
  try {
    const data = await api<{ run: OperatorRun }>(
      `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`,
    );
    if (
      generation !== state.detailGeneration ||
      projectId !== state.projectId ||
      runId !== state.runId
    )
      return;
    state.runDetail = data.run;
  } catch (error) {
    if (
      generation !== state.detailGeneration ||
      projectId !== state.projectId ||
      runId !== state.runId
    )
      return;
    state.detailError = error instanceof Error ? error.message : String(error);
    showError(error);
  } finally {
    if (
      generation === state.detailGeneration &&
      projectId === state.projectId &&
      runId === state.runId
    ) {
      state.detailLoading = false;
      renderRun();
    }
  }
}

export async function loadEvents(): Promise<void> {
  state.streamAbort?.abort();
  const generation = ++state.streamGeneration;
  const projectId = state.projectId;
  const runId = state.runId;
  state.events = [];
  state.eventIds = new Set();
  state.eventAfter = 0;
  if (state.eventFrame !== null) cancelAnimationFrame(state.eventFrame);
  state.eventFrame = null;
  state.eventError = null;
  elements["stream-status"].textContent = "";
  renderEvents();
  if (!projectId || !runId) return;
  const pageController = new AbortController();
  state.streamAbort = pageController;
  let page: Awaited<ReturnType<typeof loadEventPages>>;
  try {
    page = await loadEventPages(projectId, runId, pageController, generation);
  } catch (error) {
    if (!isCurrentEventSelection(generation, projectId, runId)) return;
    state.eventError = error instanceof Error ? error.message : String(error);
    elements["stream-status"].textContent = "Stream unavailable";
    renderEvents();
    showError(error);
    return;
  }
  if (!page) return;
  if (!isCurrentEventSelection(generation, projectId, runId)) return;
  state.events = page.events;
  state.eventIds = new Set(page.events.map((event) => event.seq));
  state.eventAfter = page.next_after;
  renderEvents();
  streamEvents(page.next_after, generation, projectId, runId).catch((error: unknown) => {
    if (
      !(error instanceof Error && error.name === "AbortError") &&
      isCurrentEventSelection(generation, projectId, runId)
    ) {
      elements["stream-status"].textContent = "Stream unavailable";
      showError(error);
    }
  });
}

async function loadEventPages(
  projectId: string,
  runId: string,
  controller: AbortController,
  generation: number,
): Promise<EventsPage | null> {
  try {
    const events: OperatorEvent[] = [];
    let after = 0;
    for (;;) {
      const page = await api<EventsPage>(
        `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/events?limit=200&after=${after}`,
        { signal: controller.signal },
      );
      if (!isCurrentEventSelection(generation, projectId, runId)) return null;
      events.push(...page.events);
      if (!page.has_more) return { events, next_after: page.next_after, has_more: false };
      if (page.next_after <= after) throw new Error("Event pagination did not advance");
      after = page.next_after;
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return null;
    throw error;
  }
}

export function isCurrentEventSelection(
  generation: number,
  projectId: string | null,
  runId: string | null,
): boolean {
  return (
    generation === state.streamGeneration && projectId === state.projectId && runId === state.runId
  );
}

async function streamEvents(
  after: number,
  generation: number,
  projectId: string,
  runId: string,
): Promise<void> {
  if (!isCurrentEventSelection(generation, projectId, runId)) return;
  const controller = new AbortController();
  state.streamAbort = controller;
  elements["stream-status"].innerHTML =
    `<span class="spinner" aria-hidden="true"></span> Live verification`;
  const response = await openEventStream(after, controller, projectId, runId);
  if (!isCurrentEventSelection(generation, projectId, runId)) {
    controller.abort();
    return;
  }
  if (!response.ok) throw new Error(`Event stream unavailable (${response.status})`);
  await consumeEventStream(response, generation, projectId, runId);
  if (!isCurrentEventSelection(generation, projectId, runId)) return;
  // Refresh only the selected durable state; historical runs and event rows stay in place.
  await loadRunDetail(state.detailGeneration, projectId, runId);
  if (!isCurrentEventSelection(generation, projectId, runId)) return;
  elements["stream-status"].textContent = "Stream paused · reconnecting";
  scheduleEventRefresh(controller, generation, projectId, runId);
}

async function openEventStream(
  after: number,
  controller: AbortController,
  projectId: string,
  runId: string,
): Promise<Response> {
  return eventStream(
    `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/events/stream?after=${after}`,
    { signal: controller.signal },
  );
}

async function consumeEventStream(
  response: Response,
  generation: number,
  projectId: string,
  runId: string,
): Promise<void> {
  if (!response.body) throw new Error("Event stream response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (!isCurrentEventSelection(generation, projectId, runId)) {
      await reader.cancel();
      break;
    }
    if (done) {
      buffer += decoder.decode();
      if (buffer.trim()) appendStreamEvents([buffer]);
      scheduleEventRender(generation, projectId, runId);
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    appendStreamEvents(lines);
    scheduleEventRender(generation, projectId, runId);
  }
}

function scheduleEventRefresh(
  controller: AbortController,
  generation: number,
  projectId: string,
  runId: string,
): void {
  if (!controller.signal.aborted && generation === state.streamGeneration) {
    setTimeout(() => {
      if (isCurrentEventSelection(generation, projectId, runId)) {
        streamEvents(state.eventAfter, generation, projectId, runId).catch((error: unknown) => {
          if (
            !(error instanceof Error && error.name === "AbortError") &&
            isCurrentEventSelection(generation, projectId, runId)
          )
            showError(error);
        });
      }
    }, 750);
  }
}

function appendStreamEvents(lines: string[]): void {
  for (const line of lines.filter(Boolean)) {
    const event = JSON.parse(line) as OperatorEvent;
    if (event.event === "stream_error") throw new Error("Event stream unavailable");
    if (event.seq && !state.eventIds.has(event.seq)) {
      state.eventIds.add(event.seq);
      state.events.push(event);
      state.eventAfter = Math.max(state.eventAfter, event.seq);
    }
  }
}

function scheduleEventRender(generation: number, projectId: string, runId: string): void {
  if (state.eventFrame !== null) return;
  state.eventFrame = requestAnimationFrame(() => {
    state.eventFrame = null;
    if (isCurrentEventSelection(generation, projectId, runId)) renderEvents();
  });
}

export async function waitForNewRun(
  previousIds: ReadonlySet<string>,
  projectId = state.projectId,
  acceptedRunId?: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (state.projectId !== projectId) return;
    const data = await api<RunsPage>(
      `/projects/${encodeURIComponent(projectId ?? "")}/runs?limit=100&view=summary`,
    );
    if (state.projectId !== projectId) return;
    const candidates = data.runs.filter((run) => !previousIds.has(run.id));
    const discovered = acceptedRunId
      ? data.runs.find((run) => run.id === acceptedRunId)
      : candidates.length === 1
        ? candidates[0]
        : null;
    if (discovered) {
      if (document.body) document.body.dataset.runView = "selected";
      state.runs = data.runs;
      await selectRun(discovered.id);
      if (state.projectId === projectId && state.runId === discovered.id) focusSelectedTask();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await loadRuns();
  showToast(
    "Start accepted, but the new run is not identified yet. Check All runs before starting again.",
    "notice",
  );
}
