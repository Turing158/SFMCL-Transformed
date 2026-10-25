import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { Provider, useApp } from "../../src/store";
import "../../src/styles.css";
import "../../src/pixel-geometry.css";
import "../../src/controls.css";
import "../../src/surfaces.css";
import "../../src/sidebar.css";
import "../../src/resources.css";
import "../../src/players.css";

// A test-only entry point exercises the real provider and the entire app.
function Driver() {
  const app = useApp();
  useEffect(() => {
    window.__notificationTest = app;
  }, [app]);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Provider>
      <App />
      <Driver />
    </Provider>
  </React.StrictMode>,
);
