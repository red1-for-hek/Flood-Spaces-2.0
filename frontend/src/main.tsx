import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { installGlobalErrorOverlay } from "./lib/crashOverlay";
import "./styles.css";
import "maplibre-gl/dist/maplibre-gl.css";

installGlobalErrorOverlay();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary
      title="Flood Spaces hit an unexpected error"
      description="The dashboard could not finish rendering. Reloading usually fixes it — your alert subscription is stored on the backend, not in this tab."
    >
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
