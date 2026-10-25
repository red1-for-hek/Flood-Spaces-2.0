/**
 * Last-resort crash reporter.
 *
 * If something throws outside React's tree (a rogue library, a rejected promise,
 * a browser API that silently refuses to work) the page would otherwise go blank.
 * Instead we paint a readable, styled overlay so the user — and we — can see what
 * happened and recover without losing context.
 */
const OVERLAY_ID = "flood-spaces-crash-overlay";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function installGlobalErrorOverlay(): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }

  const show = (title: string, detail: string) => {
    if (document.getElementById(OVERLAY_ID)) {
      return;
    }

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.setAttribute("role", "alert");
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "padding:24px",
      "background:radial-gradient(900px 500px at 50% 10%, rgba(34,211,238,.10), transparent 60%), #050a12",
      "font-family:Manrope,system-ui,-apple-system,sans-serif",
      "color:#e9eff8"
    ].join(";");

    overlay.innerHTML = `
      <div style="max-width:560px;width:100%;padding:26px 26px 22px;border-radius:20px;border:1px solid rgba(148,163,184,.22);background:linear-gradient(160deg,rgba(21,33,52,.92),rgba(9,16,28,.96));box-shadow:0 30px 70px -30px #000">
        <div style="display:inline-flex;align-items:center;gap:8px;font-size:10.5px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:#8595ab">
          <span style="width:7px;height:7px;border-radius:50%;background:#f87171;box-shadow:0 0 0 4px rgba(248,113,113,.18)"></span>
          Runtime error
        </div>
        <h1 style="margin:14px 0 8px;font-size:21px;font-weight:700;letter-spacing:-.02em">${escapeHtml(title)}</h1>
        <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#a9b8ca">
          The dashboard stopped rendering. This is usually a browser limitation (for example WebGL being
          disabled) or a transient network failure — not lost data.
        </p>
        <pre style="margin:0 0 18px;padding:12px 14px;border-radius:12px;border:1px solid rgba(148,163,184,.18);background:rgba(3,8,15,.75);color:#fca5a5;font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word">${escapeHtml(
          detail
        )}</pre>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button id="${OVERLAY_ID}-reload" style="height:40px;padding:0 18px;border:none;border-radius:12px;background:linear-gradient(140deg,#7ff0f8,#34d399);color:#04131b;font-weight:700;font-size:12.5px;cursor:pointer">Reload dashboard</button>
          <button id="${OVERLAY_ID}-copy" style="height:40px;padding:0 16px;border-radius:12px;border:1px solid rgba(148,163,184,.22);background:rgba(148,163,184,.08);color:#c3cedd;font-weight:600;font-size:12.5px;cursor:pointer">Copy details</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    overlay.querySelector(`#${OVERLAY_ID}-reload`)?.addEventListener("click", () => window.location.reload());
    overlay.querySelector(`#${OVERLAY_ID}-copy`)?.addEventListener("click", () => {
      void navigator.clipboard?.writeText(`${title}\n\n${detail}`).catch(() => undefined);
    });
  };

  window.addEventListener("error", (event) => {
    const err = event.error as Error | undefined;
    show("Something broke while rendering", `${err?.name || "Error"}: ${err?.message || event.message}`);
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason as Error | string | undefined;
    const detail =
      reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason ?? "Unknown rejection");
    show("A background request failed", detail);
  });
}
