import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";

// Live smoke: renders the app against the *real* backend, with zero mocked data,
// to catch blank-screen regressions that mocked fixtures hide.

const BASE = process.env.SMOKE_API || "http://127.0.0.1:8004";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: "http://localhost:5173/",
  pretendToBeVisual: true
});

const win = dom.window as unknown as Window & typeof globalThis;
(globalThis as Record<string, unknown>).window = win;
(globalThis as Record<string, unknown>).document = win.document;
Object.defineProperty(globalThis, "navigator", { value: win.navigator, configurable: true });
(globalThis as Record<string, unknown>).HTMLElement = win.HTMLElement;
(globalThis as Record<string, unknown>).Node = win.Node;
(globalThis as Record<string, unknown>).getComputedStyle = win.getComputedStyle.bind(win);
(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(Date.now()), 0);
(globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => clearTimeout(id);

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
(win as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverStub;

const realFetch = globalThis.fetch;
(globalThis as Record<string, unknown>).fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = String(input);
  const url = raw.startsWith("/") ? `${BASE}${raw}` : raw;
  return realFetch(url, init);
};

const errors: string[] = [];
const originalError = console.error;
console.error = (...args: unknown[]) => {
  errors.push(args.map(String).join(" "));
  originalError(...args);
};

async function main() {
  const { default: App } = await import("../src/App");
  const rootEl = win.document.getElementById("root")!;
  createRoot(rootEl).render(React.createElement(App));

  // Intro first...
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const intro = win.document.body.innerHTML;
  console.log(`intro visible: ${intro.includes("loading-screen")}`);

  // ...then the dashboard after the boot timer fires (2.2s) + real API latency.
  await new Promise((resolve) => setTimeout(resolve, 12000));
  let html = win.document.body.innerHTML;

  if (html.includes("loading-screen")) {
    console.log("still on intro after 13s (slow backend) — waiting longer");
    await new Promise((resolve) => setTimeout(resolve, 35000));
    html = win.document.body.innerHTML;
  }

  const checks: Array<[string, boolean]> = [
    ["left the intro screen", !html.includes("loading-screen")],
    ["shell mounted", html.includes("app-shell")],
    ["header rendered", html.includes("Flood Spaces</h1>")],
    ["KPI row rendered", html.includes("National risk index")],
    ["map card rendered", html.includes("Risk surface")],
    ["selected zone card", html.includes("Selected zone")],
    ["AI panel rendered", html.includes("FloodSpaces AI")],
    ["telegram card rendered", html.includes("Telegram flood bot")],
    ["footer rendered", html.includes("Flood Spaces 2.0")],
    ["error boundary NOT active", !html.includes("Something went wrong")]
  ];

  let failed = 0;
  for (const [label, ok] of checks) {
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  }

  const realErrors = errors.filter((line) => !/not wrapped in act|width\(0\) and height\(0\)/i.test(line));
  if (realErrors.length) {
    console.log("\nConsole errors:");
    for (const line of realErrors.slice(0, 10)) console.log("  -", line.slice(0, 500));
  }

  console.log(`\nbody length: ${html.length}`);
  console.log(`${failed === 0 && realErrors.length === 0 ? "LIVE SMOKE OK" : "LIVE SMOKE FAILED"} (${failed} failed checks, ${realErrors.length} console errors)`);
  process.exit(failed === 0 && realErrors.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("LIVE SMOKE CRASH", err);
  process.exit(1);
});
