import { Component, useEffect } from "react";
import type { ReactNode } from "react";
import { useApp } from "./store";
import { failStartup, revealStartup } from "./startupScreen";

export class StartupErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    failStartup(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function StartupBoundary({ children }: { children: ReactNode }) {
  const { initialized, startupError } = useApp();
  useEffect(() => {
    if (startupError) {
      failStartup(startupError);
      return;
    }
    if (!initialized) return;
    const controller = new AbortController();
    void revealStartup(
      document.getElementById("root")!,
      controller.signal,
    ).catch((error) => {
      if (!controller.signal.aborted) failStartup(error);
    });
    return () => controller.abort();
  }, [initialized, startupError]);
  return initialized ? children : null;
}
