export const CONTRACT_VERSION = "1.0" as const;

export type IsoTime = string;
export type Health = "healthy" | "degraded" | "unknown";
export type RunState = "queued" | "admitted" | "pod_pending" | "running" | "retrying" | "succeeded" | "failed" | "stopping" | "stopped" | "cleaned";

export interface Freshness {
  observedAt: IsoTime;
  source: "kubernetes" | "kueue" | "metrics" | "registry" | "qualification" | "derived";
  health: Health;
  message: string | null;
}
export interface ResourceAmount {
  cpuMillis: number;
  memoryBytes: number;
  ephemeralStorageBytes: number;
  pids: number | null;
}
export interface FutureEstimate {
  estimatedDurationSeconds: number | null;
  estimatedRemainingSeconds: number | null;
  estimatedCompletionAt: IsoTime | null;
  estimatedFinalCostUsd: number | null;
  confidence: number | null;
  calibrationError: number | null;
}
export interface LifecycleEvent {
  id: string;
  at: IsoTime;
  kind: "submitted" | "queued" | "admitted" | "started" | "retrying" | "stopping" | "terminated" | "completed" | "cleanup" | "warning";
  source: Freshness["source"];
  summary: string;
}
export interface TaskAssociation {
  id: string;
  title: string;
  trustedUrl: string | null;
}

export interface Run {
  id: string;
  namespace: string;
  jobName: string;
  jobUid: string;
  resourceVersion: string;
  stopEligible: boolean;
  workloadUid: string | null;
  podUid: string | null;
  agentType: string;
  task: TaskAssociation | null;
  state: RunState;
  node: string | null;
  attempt: number;
  imageDigest: string;
  submittedAt: IsoTime;
  admittedAt: IsoTime | null;
  startedAt: IsoTime | null;
  finishedAt: IsoTime | null;
  durationSeconds: number | null;
  terminalReason: string | null;
  request: ResourceAmount;
  peak: ResourceAmount | null;
  actualCostUsd: number | null;
  estimate: FutureEstimate;
  cleanupDeadline: IsoTime | null;
  timeline: LifecycleEvent[];
}
export interface QueueItem {
  runId: string;
  namespace: string;
  jobUid: string;
  workloadUid: string;
  position: number;
  agentType: string;
  task: TaskAssociation | null;
  reason: string;
  priority: number;
  queuedAt: IsoTime;
  ageSeconds: number;
  request: ResourceAmount;
  assignedFlavor: string | null;
  estimatedDurationSeconds: number | null;
}
export interface Queue {
  name: string;
  policy: "BestEffortFIFO" | "Unknown";
  quota: ResourceAmount;
  items: QueueItem[];
  waitP50Seconds: number | null;
  waitP95Seconds: number | null;
}
export interface Node {
  name: string;
  ready: boolean;
  schedulable: boolean;
  roles: string[];
  capacity: ResourceAmount;
  allocatable: ResourceAmount;
  reserved: ResourceAmount;
  pressure: { memory: boolean; disk: boolean; pid: boolean };
  runningRunIds: string[];
  freshness: Freshness;
}
export interface Activity {
  id: string;
  at: IsoTime;
  kind: LifecycleEvent["kind"] | "control" | "authorization";
  runId: string | null;
  agentType: string | null;
  task: TaskAssociation | null;
  subject: string;
  source: Freshness["source"];
  durationSeconds: number | null;
  summary: string;
  timeline: LifecycleEvent[];
}
export interface Image {
  digest: string;
  repository: string;
  configRevision: string;
  buildState: "pending" | "building" | "ready" | "failed" | "unknown";
  validated: boolean | null;
  sizeBytes: number | null;
  registryHealth: Health;
  prePulledNodes: string[];
  freshness: Freshness;
}
export interface Cleanup {
  runId: string;
  deadline: IsoTime | null;
  remainingObjects: Array<{ kind: string; name: string }>;
  blockedFinalizers: string[];
  orphanCount: number;
  partialUploads: number | null;
  debtFree: boolean;
  freshness: Freshness;
}
export interface Qualification {
  id: string;
  title: string;
  state: "pending" | "running" | "passed" | "failed";
  measuredValue: number | null;
  target: string;
  evidenceIds: string[];
  startedAt: IsoTime | null;
  finishedAt: IsoTime | null;
}
export interface Platform {
  clusterId: string;
  configGitSha: string;
  versions: Record<string, string>;
  certificateExpiresAt: IsoTime | null;
  rollbackReady: boolean | null;
  lastVerifiedAt: IsoTime | null;
  authorization: "system_admin";
}
export interface Session {
  subject: string;
  displayName: string | null;
  initials: string | null;
  roles: string[];
  expiresAt: IsoTime | null;
}
export interface SessionResponse { identity: Session }

export interface DashboardSnapshot {
  contractVersion: typeof CONTRACT_VERSION;
  snapshotVersion: number;
  generatedAt: IsoTime;
  freshness: Freshness[];
  capacity: {
    availableSlots: number;
    totalSlots: number;
    runningJobs: number;
    queuedJobs: number;
    cleanupDebt: number | null;
  };
  runs: Run[];
  queue: Queue;
  nodes: Node[];
  activity: Activity[];
  images: Image[];
  cleanup: Cleanup[];
  qualification: Qualification[];
  platform: Platform;
}

export type SsePayload =
  | { type: "snapshot"; snapshot: DashboardSnapshot }
  | {
      type: "upsert";
      collection: "runs" | "nodes" | "activity" | "images" | "cleanup" | "qualification";
      value: Run | Node | Activity | Image | Cleanup | Qualification;
    }
  | { type: "queue"; value: Queue }
  | { type: "remove"; collection: "runs" | "activity" | "cleanup"; id: string }
  | { type: "control_receipt"; value: ControlReceipt }
  | { type: "reset"; reason: "cursor_expired"; snapshot: DashboardSnapshot };
export interface SseEnvelope {
  contractVersion: typeof CONTRACT_VERSION;
  cursor: string;
  snapshotVersion: number;
  emittedAt: IsoTime;
  payload: SsePayload;
}
export function formatDashboardSse(envelope: SseEnvelope): string {
  return `id: ${envelope.cursor}\nevent: dashboard\ndata: ${JSON.stringify(envelope)}\n\n`;
}

export type StopMode = "graceful" | "force";
export interface ConfirmationRequest {
  namespace: string;
  jobName: string;
  jobUid: string;
  resourceVersion: string;
  mode: StopMode;
}
export interface ConfirmationGrant {
  confirmationToken: string;
  expiresAt: IsoTime;
}
export interface StopRequest {
  namespace: string;
  jobName: string;
  jobUid: string;
  resourceVersion: string;
  mode: StopMode;
  confirmationToken: string;
  idempotencyKey: string;
}
export interface ControlReceipt {
  receiptId: string;
  idempotencyKey: string;
  runId: string;
  jobUid: string;
  mode: StopMode;
  status: "accepted" | "already_terminal";
  requestedAt: IsoTime;
  acknowledgedAt: IsoTime | null;
  terminalState: "stopping" | "stopped" | "already_terminal";
  auditEventId: string;
}
export interface ApiError {
  error: {
    code: "unauthorized" | "forbidden" | "auth_unavailable" | "rate_limited" | "invalid_request" | "invalid_target" | "conflict" | "not_found" | "cursor_invalid" | "internal";
    message: string;
    requestId: string;
  };
}

export function isImmutableDigest(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}
export function encodeCursor(streamId: string, sequence: number): string {
  return `${streamId}.${sequence.toString(36)}`;
}
export function decodeCursor(cursor: string): { streamId: string; sequence: number } | null {
  const match = /^([A-Za-z0-9_-]{8,64})\.([0-9a-z]+)$/.exec(cursor);
  if (!match) return null;
  const sequence = Number.parseInt(match[2]!, 36);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? { streamId: match[1]!, sequence } : null;
}
