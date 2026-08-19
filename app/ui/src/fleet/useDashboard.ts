import { useEffect, useMemo, useRef, useState } from "react";
import { applyEnvelope, createRelayAdapter } from "./adapter";
import type { DashboardAdapter, DashboardStreamStatus, Snapshot } from "./types";

// The host decides how the fleet is reached (loopback relay in the app,
// fixtures in tests) and injects it once at start-up, so no view has to know.
let defaultAdapter: () => DashboardAdapter = () => {
  throw new Error("Fleet adapter was not configured");
};
export function configureFleetAdapter(factory: () => DashboardAdapter): void {
  defaultAdapter = factory;
}
export { createRelayAdapter };

export function useDashboard(adapter?: DashboardAdapter, onUnauthorized?: () => void) {
  const fallback = useMemo(() => defaultAdapter(), []);
  const selected = adapter ?? fallback;
  const [data, setData] = useState<Snapshot>();
  const [status, setStatus] = useState<"live" | "reconnecting" | "degraded" | "stale">("reconnecting");
  const [error, setError] = useState("");
  const seen = useRef(new Set<string>());
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;
  useEffect(() => {
    const controller = new AbortController();
    let unsubscribe: () => void = () => undefined;
    const onStatus = (next: DashboardStreamStatus) => {
      if (next === "unauthorized") {
        seen.current.clear();
        setData(undefined);
        setError("This machine's key is no longer authorized for the fleet.");
        setStatus("degraded");
        unauthorized.current?.();
      } else setStatus(next);
    };
    selected.snapshot(controller.signal).then(snapshot => {
      setData(snapshot);
      setStatus(snapshot.health === "degraded" ? "degraded" : "live");
      unsubscribe = selected.subscribe(
        snapshot.cursor,
        event => setData(current => current ? applyEnvelope(current, event, seen.current) : undefined),
        onStatus,
      );
    }).catch(cause => {
      setError(cause instanceof Error ? cause.message : "Fleet unavailable");
      setStatus("degraded");
    });
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [selected]);
  return { data, setData, status, error, adapter: selected };
}
