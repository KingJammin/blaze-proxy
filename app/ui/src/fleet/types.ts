import type { Cleanup, ConfirmationRequest, Freshness as ContractFreshness, Image, Platform, Qualification, ResourceAmount, Session, StopMode } from "../lib/dashboard-contract";
export type View = "overview" | "topology" | "queue" | "runs" | "images" | "cleanup" | "qualification" | "cost" | "platform";
export type FeedEntry = {
  id: string;
  at: string;
  kind: string;
  message: string;
};
export type Job = {
  id: string;
  uid: string;
  resourceVersion: string;
  agent: string;
  task?: string;
  node: string;
  attempt: string;
  duration: string;
  cost?: string;
  estimatedDuration?: string;
  estimatedCost?: string;
  active: boolean;
  namespace: string;
  syntheticM1: boolean;
  feed: FeedEntry[];
};
export type QueueItem = {
  id: string;
  namespace: string;
  agent: string;
  task?: string;
  age: string;
  ageSeconds: number;
  priority: string;
  request: string;
  flavor: string;
  reason: string;
  estimate?: string;
  position: number | null;
};
export type Activity = {
  id: string;
  at: string;
  tone: "success" | "warning" | "danger";
  title: string;
  description: string;
  agent: string;
  task?: string;
  taskUrl?: string;
  subject: string;
  source: string;
  duration?: string;
  cost?: string;
  timeline: { label: string; time: string }[];
};
export type Snapshot = {
  schemaVersion: "m1.v1";
  version: number;
  cursor: string;
  generatedAt: string;
  source: string;
  health: "healthy" | "degraded";
  session: Session;
  freshness: ContractFreshness[];
  capacity: {
    availableSlots: number;
    totalSlots: number;
    runningJobs: number;
    queuedJobs: number;
    cleanupDebt: number | null;
  };
  queueMeta: {
    name: string;
    policy: string;
    quota: ResourceAmount;
    waitP50Seconds: number | null;
    waitP95Seconds: number | null;
  };
  nodes: {
    name: string;
    roles: string[];
    ready: boolean;
    schedulable: boolean;
    slots: number;
    used: number;
    memory: string;
    pressure: { memory: boolean; disk: boolean; pid: boolean };
    freshness: ContractFreshness;
  }[];
  jobs: Job[];
  queue: QueueItem[];
  activity: Activity[];
  runs: {
    id: string;
    namespace: string;
    agent: string;
    task?: string;
    state: string;
    node: string;
    duration: string;
    cost?: string;
    digest: string;
    reason?: string;
    cleanup?: string;
    attempt: number;
    request: ResourceAmount;
    peak: ResourceAmount | null;
    timeline: { label: string; time: string }[];
  }[];
  images: Image[];
  cleanup: Cleanup[];
  qualification: Qualification[];
  platform: Platform;
};
export type StreamEnvelope = {
  id: string;
  version: number;
  cursor: string;
  streamId: string;
  mode: "incremental" | "snapshot" | "reset";
  snapshot: Snapshot;
};
export type StopCommand = {
  namespace: string;
  jobName: string;
  jobUid: string;
  resourceVersion: string;
  mode: StopMode;
  idempotencyKey: string;
};
export type StopReceipt = {
  receiptId: string;
  idempotencyKey: string;
  state: "accepted" | "already_requested";
  at: string;
};
export interface ConfirmationAuthority {
  issue(request: ConfirmationRequest): Promise<{ confirmationToken: string }>;
}
export type DashboardStreamStatus = "live" | "reconnecting" | "degraded" | "unauthorized";
export interface DashboardAdapter {
  snapshot(signal?: AbortSignal): Promise<Snapshot>;
  subscribe(cursor: string, onEvent: (e: StreamEnvelope) => void, onStatus: (s: DashboardStreamStatus) => void): () => void;
  stop(request: StopCommand): Promise<StopReceipt>;
}
