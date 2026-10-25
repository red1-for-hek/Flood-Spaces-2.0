/**
 * Non-blocking crash reporter.
 *
 * Design rules (learned the hard way):
 *  - A background/unhandled promise rejection must NEVER take over the screen.
 *    Third-party scripts (browser extensions, preview harnesses, analytics
 *    snippets) reject constantly; showing a full-page "Runtime error" for those
 *    is worse than the error itself.
 *  - Real render failures are already handled by React ErrorBoundary, which can
 *    show an inline panel. This module only paints a small dismissible toast and
 *    keeps the details in the console for debugging.
 */
const TOAST_ID = "flood-spaces-toast";
const AUTO_HIDE_MS = 12000;
const MAX_TOASTS = 3;

/** Cross-origin scripts report "Script error." with no stack — not actionable. */
const IGNORED_PATTERNS = [
  /^Script error\.?$/i,
  /ResizeObserver loop (limit exceeded|completed with undelivered notifications)/i,
  /Non-Error promise rejection captured/i,
  /Failed to fetch\s*$/i,
  /Load failed\s*$/i,
  /NetworkError when attempting to fetch resource/i,
  /The operation was aborted|AbortError/i
];

function isIgnored(message: string): boolean {
  return IGNORED_PATTERNS.some((pattern) => pattern.test(message.trim()));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function describe(reason: unknown): string {
  if (reason instanceof Error) {
    return `${reason.name}: ${reason.message}`;
  }
  if (typeof reason === "string") {
    return reason;
  }
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

function dismissToast(toast: HTMLElement) {
  toast.style.opacity = "0";
  toast.style.transform = "translateY(8px)";
  window.setTimeout(() => toast.remove(), 220);
}

function showToast(title: string, detail: string, tone: "warn" | "error") {
  if (typeof document === "undefined" || !document.body) {
    return;
  }

  // De-duplicate identical messages so a loop can't flood the screen.
  const existing = Array.from(document.querySelectorAll<HTMLElement>(`#${TOAST_ID} [data-message]`)).map(
    (node) => node.getAttribute("data-message")
  );
  if (existing.includes(detail)) {
    return;
  }

  let host = document.getElementById(TOAST_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = TOAST_ID;
    host.setAttribute("aria-live", "polite");
    host.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483000",
      "display:flex",
      "flex-direction:column",
      "gap:8px",
      "max-width:min(380px,calc(100vw - 32px))",
      "pointer-events:none"
    ].join(";");
    document.body.appendChild(host);
  }

  while (host.children.length >= MAX_TOASTS) {
    host.firstElementChild?.remove();
  }

  const accent = tone === "error" ? "#f87171" : "#fbbf24";
  const toast = document.createElement("div");
  toast.setAttribute("role", "status");
  toast.style.cssText = [
    "pointer-events:auto",
    "padding:12px 14px",
    "border-radius:14px",
    "border:1px solid rgba(148,163,184,.22)",
    "border-left:3px solid " + accent,
    "background:linear-gradient(160deg,rgba(18,29,46,.97),rgba(8,14,24,.98))",
    "box-shadow:0 18px 40px -22px #000",
    "font-family:Manrope,system-ui,-apple-system,sans-serif",
    "color:#e9eff8",
    "font-size:12px",
    "line-height:1.5",
    "transition:opacity .2s ease,transform .2s ease"
  ].join(";");

  toast.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:8px">
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:12px;margin-bottom:2px">${escapeHtml(title)}</div>
        <div data-message="${escapeHtml(detail)}" style="color:#8595ab;font-size:11px;word-break:break-word">${escapeHtml(
          detail.slice(0, 220)
        )}</div>
        <div style="margin-top:6px;color:#6f8098;font-size:10.5px">The dashboard keeps working.</div>
      </div>
      <button data-close style="flex:none;border:none;background:transparent;color:#8595ab;font-size:15px;line-height:1;cursor:pointer;padding:0 2px" aria-label="Dismiss">×</button>
    </div>
  `;

  toast.querySelector("[data-close]")?.addEventListener("click", () => dismissToast(toast));
  host.appendChild(toast);
  window.setTimeout(() => {
    if (toast.isConnected) dismissToast(toast);
  }, AUTO_HIDE_MS);
}

type CapturedError = { at: string; source: string; detail: string };

/** Keeps the last errors on window so they can be copied from the console. */
function record(source: string, detail: string) {
  const store = window as unknown as { __floodSpacesErrors?: CapturedError[] };
  store.__floodSpacesErrors = store.__floodSpacesErrors || [];
  store.__floodSpacesErrors.push({ at: new Date().toISOString(), source, detail });
  if (store.__floodSpacesErrors.length > 25) {
    store.__floodSpacesErrors.shift();
  }
}

export function installGlobalErrorOverlay(): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }
  if ((window as unknown as { __floodSpacesToastInstalled?: boolean }).__floodSpacesToastInstalled) {
    return;
  }
  (window as unknown as { __floodSpacesToastInstalled?: boolean }).__floodSpacesToastInstalled = true;

  window.addEventListener("unhandledrejection", (event) => {
    const detail = describe(event.reason);
    if (isIgnored(detail)) {
      return;
    }
    console.warn("[Flood Spaces] Unhandled promise rejection:", event.reason);
    record("unhandledrejection", detail);
    showToast("Background request failed", detail, "warn");
  });

  window.addEventListener("error", (event) => {
    if (!event.error) {
      return; // cross-origin "Script error." — nothing useful to show
    }
    const detail = describe(event.error);
    if (isIgnored(detail)) {
      return;
    }
    console.error("[Flood Spaces] Window error:", event.error);
    record("error", detail);
    showToast("Something failed to load", detail, "error");
  });
}
