import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import "./pixel-geometry.css";
import "./controls.css";
import "./surfaces.css";
import "./sidebar.css";
import "./resources.css";
import "./players.css";
import "./tooltip.css";
import "./window-motion.css";
import "./scrollbars.css";
import App from "./App";
import { OnboardingProvider } from "./Onboarding";
import { ConfirmationDialogHost } from "./ConfirmationDialog";
import { Provider } from "./store";
import { StartupBoundary, StartupErrorBoundary } from "./StartupBoundary";
import { TooltipHost } from "./Tooltip";
import { initializeWindowMotion } from "./windowMotion";
import { initializeScrollbars } from "./scrollbars";
import { initializeWindowSession } from "./windowSession";
import { HolidayProvider } from "./holidays/HolidayProvider";
const disposeWindowSession = initializeWindowSession();
const disposeWindowMotion = initializeWindowMotion();
const disposeScrollbars = initializeScrollbars();
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    disposeWindowSession();
    disposeWindowMotion();
    disposeScrollbars();
  });
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <StartupErrorBoundary>
      <Provider>
        <StartupBoundary>
          <HolidayProvider>
            <OnboardingProvider>
              <App />
            </OnboardingProvider>
          </HolidayProvider>
          <ConfirmationDialogHost />
          <TooltipHost />
        </StartupBoundary>
      </Provider>
    </StartupErrorBoundary>
  </React.StrictMode>,
);
