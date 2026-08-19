import { forwardRef, useEffect, useRef, useState } from "react";
import { BlazeMark, Freshness, Metric, Panel, Pill, Timeline } from "../lib/blaze-ui";
import { useDashboard } from "./useDashboard";
import type {
  Activity,
  DashboardAdapter,
  Job,
  QueueItem,
  Snapshot,
  View,
} from "./types";

const Btn = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ children, ...props }, ref) => (
  <button ref={ref} type="button" {...props}>
    {children}
  </button>
));
const unknown = (value: string | null | undefined) =>
  value && value.toLowerCase() !== "unknown" ? value : "Unknown";
const when = (value: string | null) => value ?? "Unavailable";
const duration = (seconds: number | null) =>
  seconds === null
    ? "Unavailable"
    : seconds < 60
      ? `${seconds}s`
      : `${Math.floor(seconds / 60)}m`;
const bytes = (value: number | null) =>
  value === null ? "Unavailable" : `${Math.round(value / 1048576)} MiB`;

function PageHead({
  title,
  sub,
  data,
  status,
}: {
  title: string;
  sub: string;
  data: Snapshot;
  status: "live" | "reconnecting" | "degraded" | "stale";
}) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        <p>{sub}</p>
      </div>
      <Freshness
        status={status}
        text={`Snapshot v${data.version} · ${status}`}
        source={`${data.source} · ${data.generatedAt}`}
      />
    </header>
  );
}
function Cards({
  items,
}: {
  items: {
    title: string;
    big: string;
    body: string;
    rows?: [string, string][];
  }[];
}) {
  return (
    <div className="card-grid">
      {items.map((item) => (
        <article className="info-card" key={item.title}>
          <h3>{item.title}</h3>
          <strong>{item.big}</strong>
          <p>{item.body}</p>
          {item.rows?.map((row) => (
            <div className="kv" key={row[0]}>
              <span>{row[0]}</span>
              <b>{row[1]}</b>
            </div>
          ))}
        </article>
      ))}
    </div>
  );
}
function QueueTable({
  items,
  full = false,
}: {
  items: QueueItem[];
  full?: boolean;
}) {
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">
          Observed eligible workload ordering
        </caption>
        <thead>
          <tr>
            {full && <th>Observed order</th>}
            <th>Run</th>
            <th>Namespace</th>
            <th>Agent / task</th>
            <th>Age</th>
            <th>Priority</th>
            <th>Request</th>
            <th>Flavor</th>
            <th>Reason</th>
            <th>Estimate</th>
          </tr>
        </thead>
        <tbody>
          {items.map((q) => (
            <tr key={q.id}>
              {full && (
                <td>{q.position === null ? "Unavailable" : q.position}</td>
              )}
              <td className="mono strong">{q.id}</td>
              <td className="mono">{q.namespace}</td>
              <td>
                {q.agent}
                <small>{q.task || "No associated task"}</small>
              </td>
              <td>{q.age}</td>
              <td>{q.priority}</td>
              <td>{q.request}</td>
              <td>{q.flavor}</td>
              <td>
                <Pill tone="warning">{q.reason}</Pill>
              </td>
              <td>{q.estimate || "Unavailable"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Overview({
  data,
  open,
}: {
  data: Snapshot;
  open: (value: "jobs" | "queue" | "activity") => void;
}) {
  return (
    <>
      <div className="metrics five">
        <Metric
          label="Cluster"
          value={`${data.nodes.filter((n) => n.ready).length} / ${data.nodes.length}`}
          detail="nodes Ready"
        />
        <Metric
          label="Running jobs"
          value={data.capacity.runningJobs}
          detail="snapshot observed"
          action={
            <Btn
              className="icon-button"
              aria-label="Open running jobs fullscreen"
              onClick={() => open("jobs")}
            >
              ⛶
            </Btn>
          }
        />
        <Metric
          label="Capacity"
          value={data.capacity.availableSlots}
          detail={`available · ${data.capacity.totalSlots} total slots`}
        />
        <Metric
          label="Queued"
          value={data.capacity.queuedJobs}
          detail={
            data.queue[0]
              ? `oldest observed ${duration(Math.max(...data.queue.map((q) => q.ageSeconds)))}`
              : "oldest Unavailable"
          }
          action={
            <Btn
              className="icon-button"
              aria-label="Open queue fullscreen"
              onClick={() => open("queue")}
            >
              ⛶
            </Btn>
          }
        />
        <Metric
          label="Cleanup debt"
          value={data.capacity.cleanupDebt ?? "Unavailable"}
          detail="past-deadline evidence"
        />
      </div>
      <div className="overview-stack">
        <Panel
          title="Recent activity"
          action={
            <Btn
              className="icon-button"
              aria-label="Open recent activity fullscreen"
              onClick={() => open("activity")}
            >
              ⛶
            </Btn>
          }
        >
          <ul className="activity-mini">
            {data.activity.slice(0, 10).map((a) => (
              <li key={a.id}>
                <time>{a.at}</time>
                <i className={a.tone} />
                <span>{a.title}</span>
              </li>
            ))}
          </ul>
        </Panel>
        <Topology data={data} compact />
      </div>
    </>
  );
}
function Topology({
  data,
  compact = false,
}: {
  data: Snapshot;
  compact?: boolean;
}) {
  return (
    <Panel title={compact ? "Live topology" : "Nodes, placement, and services"}>
      <div className="topology-flow">
        <div className="flow-box">
          <b>Queue</b>
          <small>{unknown(data.queueMeta.name)}</small>
          <span>{data.capacity.queuedJobs} observed workloads</span>
        </div>
        <span className="arrow">→</span>
        <div className="flow-box">
          <b>Kueue</b>
          <small>{unknown(data.queueMeta.policy)}</small>
          <span>{data.capacity.totalSlots} quota-derived slots</span>
        </div>
      </div>
      <div className="node-grid">
        {data.nodes.map((n) => {
          const pressure = Object.entries(n.pressure)
            .filter(([, v]) => v)
            .map(([k]) => k);
          return (
            <article className="node-card" key={n.name}>
              <header>
                <i className={n.ready ? "success" : "danger"} />
                <b>{n.name}</b>
                <Pill tone={n.ready ? "success" : "danger"}>
                  {n.ready ? "Ready" : "Unknown"}
                </Pill>
              </header>
              <strong>
                {n.used} / {n.slots} slots used
              </strong>
              <p>{n.roles.length ? n.roles.join(" · ") : "Roles Unknown"}</p>
              <div className="bar">
                <i
                  style={{
                    width: `${n.slots ? (n.used / n.slots) * 100 : 0}%`,
                  }}
                />
              </div>
              <small>
                Memory {n.memory} · pressure{" "}
                {pressure.length ? pressure.join(", ") : "none observed"} ·{" "}
                {n.freshness.observedAt}
              </small>
            </article>
          );
        })}
      </div>
    </Panel>
  );
}
function Dialog({
  title,
  sub,
  close,
  children,
}: {
  title: string;
  sub: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const listener = (event: KeyboardEvent) =>
      event.key === "Escape" && close();
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [close]);
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={title}>
      <header>
        <div>
          <h1>{title}</h1>
          <p>{sub}</p>
        </div>
        <Btn
          ref={ref}
          className="close"
          aria-label={`Close ${title}`}
          onClick={close}
        >
          ×
        </Btn>
      </header>
      {children}
    </div>
  );
}
function RunningWorkspace({
  data,
  close,
  adapter,
}: {
  data: Snapshot;
  close: () => void;
  adapter: DashboardAdapter;
}) {
  const [selected, setSelected] = useState(data.jobs[0]?.id);
  const [confirm, setConfirm] = useState(false);
  const [receipt, setReceipt] = useState("");
  const [stopError, setStopError] = useState("");
  const [stopping, setStopping] = useState(false);
  const job = data.jobs.find((j) => j.id === selected) as Job | undefined;
  if (!job)
    return (
      <Dialog title="Running jobs" sub="No active jobs" close={close}>
        <p className="empty-state">Unavailable</p>
      </Dialog>
    );
  const action = async () => {
    setStopping(true);
    setStopError("");
    try {
      const result = await adapter.stop({
        namespace: job.namespace,
        jobName: job.id,
        jobUid: job.uid,
        resourceVersion: job.resourceVersion,
        mode: "graceful",
        idempotencyKey: `stop-${job.uid}-${job.resourceVersion}-graceful`,
      });
      setReceipt(`${result.receiptId} · ${result.state}`);
      setConfirm(false);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown error";
      setStopError(`Stop was not accepted. Refresh the run and retry. ${detail}`);
    } finally {
      setStopping(false);
    }
  };
  return (
    <Dialog
      title="Running jobs"
      sub={`${data.jobs.length} active jobs · newest feed entries first`}
      close={close}
    >
      <div className="workspace">
        <div className="selection-list" role="listbox">
          {data.jobs.map((j) => (
            <Btn
              key={j.id}
              role="option"
              aria-selected={selected === j.id}
              onClick={() => {
                setSelected(j.id);
                setConfirm(false);
                setReceipt("");
                setStopError("");
              }}
            >
              <b>{j.id}</b>
              <span>
                {j.agent} · {j.node}
              </span>
            </Btn>
          ))}
        </div>
        <section className="workspace-detail">
          <div className="detail-head">
            <div>
              <h2>{job.id}</h2>
              <p>
                {job.namespace} · {job.agent} · {job.task || "No associated task"}
              </p>
            </div>
            <Btn
              className="danger-button"
              disabled={!job.active || !job.syntheticM1}
              onClick={() => setConfirm(true)}
            >
              Stop
            </Btn>
          </div>
          {confirm && (
            <div
              className="confirm"
              role="alertdialog"
              aria-label={`Stop ${job.id}`}
            >
              <div>
                <b>Stop {job.id}?</b>
                <p>Graceful stop preserves the termination policy.</p>
              </div>
              <div>
                <Btn onClick={() => setConfirm(false)}>Cancel</Btn>
                <Btn className="danger-button" disabled={stopping} onClick={action}>
                  {stopping ? "Stopping…" : "Confirm stop"}
                </Btn>
              </div>
            </div>
          )}
          {stopError && <p className="notice" role="alert">{stopError}</p>}
          {receipt && <p className="receipt">Audit receipt: {receipt}</p>}
          <ol className="job-feed">
            {job.feed.map((f) => (
              <li key={f.id}>
                <time>{f.at}</time>
                <em>{f.kind}</em>
                <span>{f.message}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </Dialog>
  );
}
function ActivityWorkspace({
  data,
  close,
}: {
  data: Snapshot;
  close: () => void;
}) {
  const [id, setId] = useState(data.activity[0]?.id);
  const a = data.activity.find((x) => x.id === id) as Activity | undefined;
  if (!a)
    return (
      <Dialog title="Recent activity" sub="No activity observed" close={close}>
        <p className="empty-state">Unavailable</p>
      </Dialog>
    );
  return (
    <Dialog
      title="Recent activity"
      sub="Kubernetes and Kueue-derived evidence"
      close={close}
    >
      <div className="workspace">
        <div className="selection-list">
          {data.activity.map((x) => (
            <Btn key={x.id} onClick={() => setId(x.id)}>
              <b>{x.title}</b>
              <small>{x.source}</small>
            </Btn>
          ))}
        </div>
        <section className="workspace-detail">
          <h2>{a.title}</h2>
          <p>{a.description}</p>
          {a.taskUrl && (
            <a
              className="task-link"
              href={a.taskUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open associated task ↗
            </a>
          )}
          <Timeline items={a.timeline} />
        </section>
      </div>
    </Dialog>
  );
}
function Runs({ data }: { data: Snapshot }) {
  const [id, setId] = useState(data.runs[0]?.id);
  const run = data.runs.find((r) => r.id === id);
  return (
    <>
      <Panel title="Recent runs">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Namespace</th>
                <th>Agent</th>
                <th>State</th>
                <th>Node</th>
                <th>Duration</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r) => (
                <tr key={r.id} tabIndex={0} onClick={() => setId(r.id)}>
                  <td>{r.id}</td>
                  <td className="mono">{r.namespace}</td>
                  <td>{r.agent}</td>
                  <td>
                    <Pill tone={r.state === "Running" ? "running" : "success"}>
                      {r.state}
                    </Pill>
                  </td>
                  <td>{r.node}</td>
                  <td>{r.duration}</td>
                  <td>{r.cost || "Unavailable"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      {run && (
        <Panel title={`Run detail · ${run.id}`}>
          <Cards
            items={[
              {
                title: "Agent",
                big: run.agent,
                body: `${run.namespace} · ${run.node} · attempt ${run.attempt}`,
              },
              {
                title: "Resources",
                big: `${run.request.cpuMillis / 1000} CPU · ${bytes(run.request.memoryBytes)}`,
                body: run.peak
                  ? `Peak ${run.peak.cpuMillis / 1000} CPU · ${bytes(run.peak.memoryBytes)}`
                  : "Peak Unavailable",
              },
              {
                title: "Terminal / cleanup",
                big: run.reason || "In progress",
                body: run.cleanup
                  ? `Cleanup ${run.cleanup}`
                  : "Cleanup deadline Unavailable",
              },
            ]}
          />
          <p className="mono">{run.digest}</p>
          <Timeline items={run.timeline} />
        </Panel>
      )}
    </>
  );
}
function Images({ data }: { data: Snapshot }) {
  if (!data.images.length)
    return (
      <Cards
        items={[
          {
            title: "Image inventory",
            big: "Unavailable",
            body: "No registry/image evidence in this snapshot",
          },
        ]}
      />
    );
  return (
    <Cards
      items={data.images.map((image) => ({
        title: image.repository,
        big: image.buildState,
        body: `Observed ${image.freshness.observedAt}`,
        rows: [
          ["Digest", image.digest],
          ["Config", unknown(image.configRevision)],
          [
            "Validated",
            image.validated === null
              ? "Unknown"
              : image.validated
                ? "Yes"
                : "No",
          ],
          ["Registry", image.registryHealth],
          ["Size", bytes(image.sizeBytes)],
          [
            "Pre-pulled nodes",
            image.prePulledNodes.length
              ? image.prePulledNodes.join(", ")
              : "Unavailable",
          ],
        ],
      }))}
    />
  );
}
function CleanupView({ data }: { data: Snapshot }) {
  const blocked = data.cleanup.reduce(
      (n, c) => n + c.blockedFinalizers.length,
      0,
    ),
    partials = data.cleanup.some((c) => c.partialUploads === null)
      ? null
      : data.cleanup.reduce((n, c) => n + (c.partialUploads ?? 0), 0);
  return (
    <>
      <Cards
        items={[
          {
            title: "Cleanup debt",
            big:
              data.capacity.cleanupDebt === null
                ? "Unavailable"
                : String(data.capacity.cleanupDebt),
            body: "Past-deadline cleanup evidence",
          },
          {
            title: "Blocked finalizers",
            big: data.cleanup.length ? String(blocked) : "Unavailable",
            body: data.cleanup.length
              ? "Snapshot records"
              : "No cleanup source records",
          },
          {
            title: "Partial uploads",
            big:
              data.cleanup.length && partials !== null
                ? String(partials)
                : "Unavailable",
            body: data.cleanup.length
              ? "Registry evidence"
              : "No cleanup source records",
          },
        ]}
      />
      <Panel title="TTL and cleanup evidence">
        {data.cleanup.length ? (
          data.cleanup.map((c) => (
            <div className="kv" key={c.runId}>
              <span>
                {c.runId} · deadline {when(c.deadline)}
              </span>
              <b>
                {c.debtFree
                  ? "Debt free"
                  : `${c.remainingObjects.length} remaining`}
              </b>
            </div>
          ))
        ) : (
          <div className="empty-state">
            <b>Unavailable</b>
            <p>
              No cleanup evidence records were supplied; absence is not proof of
              zero debt.
            </p>
          </div>
        )}
      </Panel>
    </>
  );
}
function QualificationView({ data }: { data: Snapshot }) {
  return data.qualification.length ? (
    <div className="qualification">
      {data.qualification.map((q, i) => (
        <article key={q.id}>
          <span>{String(i + 1).padStart(2, "0")}</span>
          <div>
            <b>{q.title}</b>
            <small>
              {q.measuredValue === null
                ? "Measured value Unavailable"
                : `Measured ${q.measuredValue}`}{" "}
              · target {q.target}
            </small>
          </div>
          <Pill
            tone={
              q.state === "passed"
                ? "success"
                : q.state === "failed"
                  ? "danger"
                  : "warning"
            }
          >
            {q.state}
          </Pill>
        </article>
      ))}
    </div>
  ) : (
    <Cards
      items={[
        {
          title: "Qualification",
          big: "Unavailable",
          body: "No qualification evidence in this snapshot",
        },
      ]}
    />
  );
}
function PlatformView({ data }: { data: Snapshot }) {
  const p = data.platform;
  return (
    <Cards
      items={[
        {
          title: "Release / configuration",
          big: unknown(p.versions.release),
          body: `config Git SHA ${unknown(p.configGitSha)}`,
          rows: [
            ["Contract", unknown(p.versions.contract)],
            ["Snapshot", `v${data.version}`],
          ],
        },
        {
          title: "Authorization",
          big: data.session.roles.length
            ? data.session.roles.join(", ")
            : "Unknown",
          body: "Authenticated session; UI is not an authorization boundary",
        },
        {
          title: "Certificates",
          big: p.certificateExpiresAt ? "Observed" : "Unavailable",
          body: p.certificateExpiresAt
            ? `Expires ${p.certificateExpiresAt}`
            : "No certificate source in snapshot",
          rows: [["Last verification", when(p.lastVerifiedAt)]],
        },
        {
          title: "Rollback",
          big: p.rollbackReady ? "Ready" : "Unknown",
          body: p.rollbackReady
            ? "Snapshot reports rollback ready"
            : "Readiness not established",
          rows: [
            ["Cluster", unknown(p.clusterId)],
            ["Kubernetes", unknown(p.versions.kubernetes)],
          ],
        },
      ]}
    />
  );
}
function StaticView({ view, data }: { view: View; data: Snapshot }) {
  if (view === "topology") return <Topology data={data} />;
  if (view === "runs") return <Runs data={data} />;
  if (view === "images") return <Images data={data} />;
  if (view === "cleanup") return <CleanupView data={data} />;
  if (view === "qualification") return <QualificationView data={data} />;
  if (view === "cost")
    return (
      <div className="notice">
        Unavailable · cost attribution and predictions are not supplied by the
        live M1 snapshot.
      </div>
    );
  if (view === "platform") return <PlatformView data={data} />;
  return null;
}
const subtitles: Record<View, string> = {
  overview: "Live execution substrate and cleanup health",
  topology: "Placement, pressure, services, and reserved headroom",
  queue: "Observed eligible ordering, wait reasons, and resource flavor",
  runs: "Agent ownership, associated work, resources, and lifecycle",
  images: "Immutable builds, registry health, and node distribution",
  cleanup: "TTL countdowns, remaining objects, and cleanup evidence",
  qualification: "M1 scenarios, evidence, SLOs, and milestone gate",
  cost: "Cost attribution, time estimates, and calibration",
  platform: "Versions, authorization, certificates, and rollback readiness",
};

// The desktop app owns the window chrome — title bar, sidebar, identity — so
// this renders only the page head and the selected view. The dashboard-web
// build keeps its own shell; this is the embedded twin.
export function FleetPane({ view }: { view: View }) {
  const { data, status, error, adapter: used } = useDashboard();
  const [overlay, setOverlay] = useState<"jobs" | "queue" | "activity" | null>(
    null,
  );
  if (!data)
    return (
      <div className="fleet-loading">
        <BlazeMark />
        <p role="status">{error || "Loading fleet snapshot…"}</p>
      </div>
    );
  return (
    <>
      <PageHead
        title={view === "overview" ? "Fleet overview" : titles[view]}
        sub={subtitles[view]}
        data={data}
        status={status}
      />
      {view === "overview" ? (
        <Overview data={data} open={setOverlay} />
      ) : view === "queue" ? (
        <>
          <div className="metrics four">
            <Metric
              label="Capacity"
              value={data.capacity.availableSlots}
              detail={`available · ${data.capacity.runningJobs} running`}
            />
            <Metric
              label="Pending"
              value={data.capacity.queuedJobs}
              detail="observed workloads"
            />
            <Metric
              label="Wait p95"
              value={duration(data.queueMeta.waitP95Seconds)}
              detail="snapshot statistic"
            />
            <Metric
              label="Oldest"
              value={
                data.queue.length
                  ? duration(Math.max(...data.queue.map((q) => q.ageSeconds)))
                  : "Unavailable"
              }
              detail="observed age"
            />
          </div>
          <Panel
            title="Pending workloads"
            action={<Btn onClick={() => setOverlay("queue")}>Open fullscreen</Btn>}
          >
            <QueueTable items={data.queue} />
          </Panel>
        </>
      ) : (
        <StaticView view={view} data={data} />
      )}
      {overlay === "jobs" && (
        <RunningWorkspace
          data={data}
          close={() => setOverlay(null)}
          adapter={used}
        />
      )}
      {overlay === "activity" && (
        <ActivityWorkspace data={data} close={() => setOverlay(null)} />
      )}
      {overlay === "queue" && (
        <Dialog
          title="Queue"
          sub={`Observed eligible ordering · ${data.capacity.queuedJobs} workloads · source kueue · ${data.generatedAt}`}
          close={() => setOverlay(null)}
        >
          <Panel title="All queued workloads">
            <QueueTable items={data.queue} full />
          </Panel>
        </Dialog>
      )}
    </>
  );
}
export const titles: Record<View, string> = {
  overview: "Fleet overview",
  topology: "Topology",
  queue: "Queue",
  runs: "Runs",
  images: "Images",
  cleanup: "Cleanup",
  qualification: "Qualification",
  cost: "Cost & time",
  platform: "Platform",
};
