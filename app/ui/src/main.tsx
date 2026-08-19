import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FleetPane } from "./fleet/App";
import { configureFleetAdapter, createRelayAdapter } from "./fleet/useDashboard";
import type { View } from "./fleet/types";
import "./fleet/styles.css";
import "./fleet.css";

// Bridge between the vanilla shell (sidebar, title bar, Proxy pane) and the
// React fleet views. The shell stays in charge of navigation; this exposes the
// two calls it needs and nothing else.
//
// The pane is only mounted once Agents is first opened, so a machine with no
// fleet configured never opens a snapshot request or an event stream.

let root: Root | undefined;
let host: HTMLElement | undefined;

function render(view: View): void {
  if (!host) return;
  root ??= createRoot(host);
  root.render(
    <StrictMode>
      <FleetPane view={view} />
    </StrictMode>,
  );
}

const api = {
  /** Called once, before the first show(). */
  start(container: HTMLElement, port: string): void {
    host = container;
    configureFleetAdapter(() => createRelayAdapter(port));
  },
  /** Mount (or switch) the fleet pane to a view. */
  show(view: View): void {
    render(view);
  },
  /** Tear the pane down so its event stream closes. */
  stop(): void {
    root?.unmount();
    root = undefined;
  },
};

declare global {
  interface Window {
    blazeFleet: typeof api;
  }
}
window.blazeFleet = api;
