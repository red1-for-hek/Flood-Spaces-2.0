/**
 * MapLibre needs WebGL2. Some environments (locked-down browsers, blocklisted
 * GPUs, sandboxed iframes, remote desktops) silently refuse it, and MapLibre
 * throws during map construction — which used to unmount the whole React tree.
 */
export function supportsWebgl2(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    if (gl) {
      // Release the probe context so we don't burn one of the browser's slots.
      const lose = (gl as WebGL2RenderingContext & { getExtension?: (name: string) => unknown }).getExtension?.(
        "WEBGL_lose_context"
      ) as { loseContext?: () => void } | null;
      lose?.loseContext?.();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
