import type { Status } from "../types.js";

export interface RequestValidationArgs {
  proposed_text:   string;
  proposed_status: Status;
  similar_entry:   string;   // empty string when no similar entry was found
  question:        string;
}

/**
 * Present a router-proposed memory operation to Claude for review.
 *
 * Returns a formatted prompt. Claude's natural-language reply is the decision:
 *   "confirmed"           → write as proposed
 *   "corrected:<status>"  → write with the corrected status
 *   "skip"                → discard this entry
 *
 * Invoked only when router confidence is 0.5–0.75.
 * Above 0.75 the router writes directly. Below 0.5 it discards silently.
 */
export function requestValidationTool(a: RequestValidationArgs): string {
  const lines = [
    "Memory validation request from router:",
    "",
    `  Proposed text:   ${a.proposed_text}`,
    `  Proposed status: ${a.proposed_status}`,
  ];

  if (a.similar_entry) {
    lines.push(`  Similar entry:   ${a.similar_entry}`);
  }

  lines.push(
    "",
    `  Question: ${a.question}`,
    "",
    "Respond with one of:",
    "  confirmed            — write the entry as proposed",
    "  corrected:<status>   — write with corrected status  (e.g. corrected:resolved)",
    "  skip                 — discard; this entry is irrelevant or wrong",
  );

  return lines.join("\n");
}
