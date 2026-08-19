import { decodeCursor, type ControlReceipt, type DashboardSnapshot, type Session, type SessionResponse, type SseEnvelope, type StopRequest } from "../lib/dashboard-contract";
import { fixtureSnapshot } from "./fixtures";
import type { ConfirmationAuthority, DashboardAdapter, DashboardStreamStatus, Snapshot, StopCommand, StopReceipt, StreamEnvelope } from "./types";
const NAMESPACE = "frontro-agent-prototype";
const defaultFetcher: typeof fetch = (...args) => globalThis.fetch(...args);
export function sessionProbeDisposition(status: number): "authenticated" | "invalid" | "retry" {
  if (status >= 200 && status < 300) return "authenticated";
  return status === 401 || status === 403 ? "invalid" : "retry";
}
export class FixtureDashboardAdapter implements DashboardAdapter {
  private data: Snapshot = structuredClone(fixtureSnapshot);
  private seen = new Map<string, StopReceipt>();
  async snapshot() {
    return structuredClone(this.data);
  }
  subscribe(_cursor: string, _onEvent: (e: StreamEnvelope) => void, onStatus: (s: "live" | "reconnecting" | "degraded") => void) {
    onStatus("live");
    return () => undefined;
  }
  async stop(r: StopCommand): Promise<StopReceipt> {
    const prior = this.seen.get(r.idempotencyKey);
    if (prior) return { ...prior, state: "already_requested" };
    const job = this.data.jobs.find((x) => x.id === r.jobName);
    if (!job || !job.active || !job.syntheticM1 || r.namespace !== NAMESPACE || job.namespace !== NAMESPACE || job.uid !== r.jobUid || job.resourceVersion !== r.resourceVersion) throw new Error("Job is no longer eligible to stop. Refresh and try again.");
    job.active = false;
    job.feed = [
      {
        id: `control-${r.idempotencyKey}`,
        at: "now",
        kind: "control",
        message: r.mode === "force" ? "Force terminate accepted" : "Graceful stop accepted",
      },
      ...job.feed,
    ];
    const receipt: StopReceipt = {
      receiptId: "receipt-fixture-01",
      idempotencyKey: r.idempotencyKey,
      state: "accepted",
      at: new Date().toISOString(),
    };
    this.seen.set(r.idempotencyKey, receipt);
    return receipt;
  }
}
export function applyEnvelope(current: Snapshot, envelope: StreamEnvelope, seen: Set<string>) {
  if (seen.has(envelope.id)) return current;
  const currentStreamId = decodeCursor(current.cursor)?.streamId;
  const streamChanged = currentStreamId !== undefined && currentStreamId !== envelope.streamId;
  if (envelope.mode === "incremental" && (streamChanged || envelope.version <= current.version)) return current;
  if (envelope.mode === "reset" || streamChanged) seen.clear();
  seen.add(envelope.id);
  return envelope.snapshot;
}
export class HttpConfirmationAuthority implements ConfirmationAuthority {
  constructor(
    private readonly apiBase: string,
    private readonly fetcher: typeof fetch = defaultFetcher,
  ) {}
  async issue(request: StopCommand) {
    const { idempotencyKey: _ignored, ...body } = request;
    void _ignored;
    const response = await this.fetcher(`${this.apiBase}/v1/confirmations`, {
      method: "POST",
      credentials: "omit",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Confirmation unavailable (${response.status})`);
    const grant = (await response.json()) as { confirmationToken?: unknown };
    if (typeof grant.confirmationToken !== "string" || grant.confirmationToken.length < 16) throw new Error("Confirmation authority returned an invalid grant");
    return { confirmationToken: grant.confirmationToken };
  }
}
export class HttpDashboardAdapter implements DashboardAdapter {
  private contract?: DashboardSnapshot;
  private session?: Session;
  private streamId?: string;
  constructor(
    private readonly apiBase: string,
    private readonly confirmations: ConfirmationAuthority = new HttpConfirmationAuthority(apiBase),
    private readonly fetcher: typeof fetch = defaultFetcher,
    private readonly EventSourceClass: typeof EventSource = EventSource,
  ) {}
  async snapshot(signal?: AbortSignal) {
    const init = {
      credentials: "omit" as const,
      signal,
      headers: { Accept: "application/json" },
    };
    const [r, s] = await Promise.all([this.fetcher(`${this.apiBase}/v1/snapshot`, init), this.fetcher(`${this.apiBase}/v1/session`, init)]);
    if (!r.ok) throw new Error(`Snapshot unavailable (${r.status})`);
    if (!s.ok) throw new Error(`Session unavailable (${s.status})`);
    this.contract = (await r.json()) as DashboardSnapshot;
    this.session = ((await s.json()) as SessionResponse).identity;
    return translateSnapshot(this.contract, "", this.session);
  }
  subscribe(cursor: string, onEvent: (e: StreamEnvelope) => void, onStatus: (s: DashboardStreamStatus) => void) {
    let closed = false,
      resumeCursor = cursor,
      source: EventSource | undefined,
      timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (closed) return;
      onStatus("reconnecting");
      const suffix = resumeCursor ? `?cursor=${encodeURIComponent(resumeCursor)}` : "";
      const connection = new this.EventSourceClass(`${this.apiBase}/v1/events${suffix}`, {
        withCredentials: false,
      });
      source = connection;
      connection.onopen = () => onStatus("live");
      connection.addEventListener("dashboard", (event: Event) => {
        try {
          const envelope = JSON.parse((event as MessageEvent).data) as SseEnvelope;
          if (envelope.contractVersion !== "1.0" || !decodeCursor(envelope.cursor)) throw new Error("Invalid SSE cursor");
          const translated = this.applyContractEnvelope(envelope);
          resumeCursor = envelope.cursor;
          if (translated) onEvent(translated);
        } catch {
          onStatus("degraded");
        }
      });
      connection.onerror = () => {
        if (closed || source !== connection) return;
        onStatus("degraded");
        connection.close();
        source = undefined;
        void this.authorizationWasRevoked().then(revoked => {
          if (closed || source) return;
          if (revoked) {
            onStatus("unauthorized");
            return;
          }
          if (timer) clearTimeout(timer);
          timer = setTimeout(connect, 2000);
        });
      };
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      source?.close();
    };
  }
  private async authorizationWasRevoked(): Promise<boolean> {
    try {
      const response = await this.fetcher(`${this.apiBase}/v1/session`, {
        credentials: "omit",
        headers: { Accept: "application/json" },
      });
      return response.status === 401 || response.status === 403;
    } catch {
      return false;
    }
  }
  async stop(command: StopCommand) {
    const grant = await this.confirmations.issue(command);
    const request: StopRequest = {
      namespace: command.namespace,
      jobName: command.jobName,
      jobUid: command.jobUid,
      resourceVersion: command.resourceVersion,
      mode: command.mode,
      confirmationToken: grant.confirmationToken,
      idempotencyKey: command.idempotencyKey,
    };
    const route = request.mode === "force" ? "force-terminate" : "stop";
    const r = await this.fetcher(`${this.apiBase}/v1/jobs/${encodeURIComponent(request.jobName)}/${route}`, {
      method: "POST",
      credentials: "omit",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": request.idempotencyKey,
      },
      body: JSON.stringify(request),
    });
    if (!r.ok) throw new Error(`Stop rejected (${r.status})`);
    return translateReceipt((await r.json()) as ControlReceipt);
  }
  private applyContractEnvelope(envelope: SseEnvelope): StreamEnvelope | undefined {
    if (envelope.contractVersion !== "1.0" || !this.contract) return undefined;
    const cursor = decodeCursor(envelope.cursor);
    if (!cursor) return undefined;
    const payload = envelope.payload;
    const authoritative = payload.type === "snapshot" || payload.type === "reset";
    const streamChanged = this.streamId !== undefined && this.streamId !== cursor.streamId;
    if (!authoritative && (streamChanged || envelope.snapshotVersion <= this.contract.snapshotVersion)) return undefined;
    if (payload.type === "snapshot" || payload.type === "reset") this.contract = payload.snapshot;
    else if (payload.type === "queue")
      this.contract = {
        ...this.contract,
        queue: payload.value,
        snapshotVersion: envelope.snapshotVersion,
      };
    else if (payload.type === "upsert") {
      const collection = payload.collection;
      const values = this.contract[collection] as Array<{
        id?: string;
        name?: string;
      }>;
      const value = payload.value as { id?: string; name?: string };
      const key = value.id ?? value.name;
      this.contract = {
        ...this.contract,
        [collection]: [...values.filter((item) => (item.id ?? item.name) !== key), value],
        snapshotVersion: envelope.snapshotVersion,
      };
    } else if (payload.type === "remove") {
      const collection = payload.collection;
      this.contract = {
        ...this.contract,
        [collection]: this.contract[collection].filter((item) => ("id" in item ? item.id : item.runId) !== payload.id),
        snapshotVersion: envelope.snapshotVersion,
      };
    } else return undefined;
    this.streamId = cursor.streamId;
    return {
      id: envelope.cursor,
      version: envelope.snapshotVersion,
      cursor: envelope.cursor,
      streamId: cursor.streamId,
      mode: payload.type === "reset" ? "reset" : payload.type === "snapshot" ? "snapshot" : "incremental",
      snapshot: translateSnapshot(this.contract, envelope.cursor, this.session),
    };
  }
}
// In the desktop app the dashboard is reached through the daemon's loopback
// relay, which attaches this machine's stored key. There is no login, no
// cookie, and no remote origin in the window's CSP.
export function createRelayAdapter(port: string | number): DashboardAdapter {
  return new HttpDashboardAdapter(`http://127.0.0.1:${port}/__blaze/fleet`);
}
export function createFixtureAdapter(): DashboardAdapter {
  return new FixtureDashboardAdapter();
}
export function translateSnapshot(
  value: DashboardSnapshot,
  cursor: string,
  session: Session = {
    subject: "Unavailable",
    displayName: null,
    initials: null,
    roles: [],
    expiresAt: null,
  },
): Snapshot {
  if (value.contractVersion !== "1.0" || !Number.isSafeInteger(value.snapshotVersion) || !Array.isArray(value.runs) || !value.queue || !Array.isArray(value.queue.items)) throw new Error("Unsupported dashboard snapshot contract");
  const health = value.freshness.some((item) => item.health !== "healthy") ? "degraded" : "healthy";
  const duration = (seconds: number | null) => (seconds === null ? "Unavailable" : seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`);
  const memory = (bytes: number) => `${Math.round(bytes / 1073741824)} GiB`;
  return {
    schemaVersion: "m1.v1",
    version: value.snapshotVersion,
    cursor,
    generatedAt: value.generatedAt,
    source: "Live · dashboard-api",
    health,
    session,
    freshness: value.freshness,
    capacity: value.capacity,
    queueMeta: {
      name: value.queue.name,
      policy: value.queue.policy,
      quota: value.queue.quota,
      waitP50Seconds: value.queue.waitP50Seconds,
      waitP95Seconds: value.queue.waitP95Seconds,
    },
    nodes: value.nodes.map((node) => ({
      name: node.name,
      roles: node.roles,
      ready: node.ready,
      schedulable: node.schedulable,
      slots: Math.floor(node.allocatable.cpuMillis / 1000),
      used: Math.ceil(value.runs.filter((run) => run.node === node.name && ["pod_pending","running","retrying","stopping"].includes(run.state)).reduce((sum,run)=>sum+run.request.cpuMillis,0)/1000),
      memory: `${memory(node.reserved.memoryBytes)} reserved / ${memory(node.capacity.memoryBytes)}`,
      pressure: node.pressure,
      freshness: node.freshness,
    })),
    jobs: value.runs
      .filter((run) => ["pod_pending", "running", "retrying", "stopping"].includes(run.state))
      .map((run) => ({
        id: run.jobName,
        uid: run.jobUid,
        resourceVersion: run.resourceVersion,
        agent: run.agentType,
        task: run.task?.title,
        node: run.node ?? "Pending",
        attempt: String(run.attempt),
        duration: duration(run.durationSeconds),
        cost: run.actualCostUsd === null ? undefined : `$${run.actualCostUsd.toFixed(2)}`,
        estimatedDuration: duration(run.estimate.estimatedDurationSeconds),
        estimatedCost: run.estimate.estimatedFinalCostUsd === null ? undefined : `$${run.estimate.estimatedFinalCostUsd.toFixed(2)}`,
        active: ["pod_pending", "running", "retrying"].includes(run.state),
        namespace: run.namespace,
        syntheticM1: run.stopEligible === true,
        feed: run.timeline
          .slice()
          .reverse()
          .map((event) => ({
            id: event.id,
            at: event.at,
            kind: event.kind,
            message: event.summary,
          })),
      })),
    queue: value.queue.items.map((item) => ({
      id: item.runId,
      namespace: item.namespace,
      agent: item.agentType,
      task: item.task?.title,
      age: duration(item.ageSeconds),
      ageSeconds: item.ageSeconds,
      priority: String(item.priority),
      request: `${item.request.cpuMillis / 1000} CPU · ${memory(item.request.memoryBytes)}`,
      flavor: item.assignedFlavor ?? "Unassigned",
      reason: item.reason,
      estimate: duration(item.estimatedDurationSeconds),
      position: Number.isSafeInteger(item.position) ? item.position : null,
    })),
    activity: value.activity.map((item) => ({
      id: item.id,
      at: item.at,
      tone: item.kind === "warning" ? "warning" : item.kind === "authorization" ? "danger" : "success",
      title: item.summary,
      description: item.summary,
      agent: item.agentType ?? "Platform",
      task: item.task?.title,
      taskUrl: item.task?.trustedUrl ?? undefined,
      subject: item.subject,
      source: item.source,
      duration: duration(item.durationSeconds),
      timeline: item.timeline.map((event) => ({
        label: event.summary,
        time: event.at,
      })),
    })),
    runs: value.runs.map((run) => ({
      id: run.id,
      namespace: run.namespace,
      agent: run.agentType,
      task: run.task?.title,
      state: run.state[0]!.toUpperCase() + run.state.slice(1),
      node: run.node ?? "Pending",
      duration: duration(run.durationSeconds),
      cost: run.actualCostUsd === null ? undefined : `$${run.actualCostUsd.toFixed(2)}`,
      digest: run.imageDigest,
      reason: run.terminalReason ?? undefined,
      cleanup: run.cleanupDeadline ?? undefined,
      attempt: run.attempt,
      request: run.request,
      peak: run.peak,
      timeline: run.timeline.map((event) => ({
        label: event.summary,
        time: event.at,
      })),
    })),
    images: value.images,
    cleanup: value.cleanup,
    qualification: value.qualification,
    platform: value.platform,
  };
}
function translateReceipt(receipt: ControlReceipt): StopReceipt {
  return {
    receiptId: receipt.receiptId,
    idempotencyKey: receipt.idempotencyKey,
    state: receipt.status === "accepted" ? "accepted" : "already_requested",
    at: receipt.requestedAt,
  };
}
