// Design flags from the SecuroServ v2 handoff. Defaults match the design.
// Override for a review with the URL, e.g. ?headerStyle=Split%20weight or ?filings=0.
// liquidGlass (default off) is not built: the header pills use the v1 CSS glass fallback.

export const HEADER_STYLES = ["Classic", "Split weight", "With tag", "Stacked", "Spaced caps"] as const;
export type HeaderStyle = (typeof HEADER_STYLES)[number];

function param(name: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

const hs = param("headerStyle");
export const headerStyle: HeaderStyle = HEADER_STYLES.find((s) => s === hs) ?? "Classic";
export const filings = param("filings") !== "0";
