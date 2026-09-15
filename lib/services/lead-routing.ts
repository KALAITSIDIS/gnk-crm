/**
 * How a website enquiry is assigned on arrival (0098, audit LR-05).
 *
 * The rule lives in `cyprus_config.lead_routing` as
 * `{ mode: "off" | "round_robin", agents: [profile ids] }` and is APPLIED by
 * the database — `submit_public_enquiry` reads it at insert time, because the
 * function holds the lead id and the route learns it only afterwards. This
 * module is the app's reader of the same row, for the settings page and
 * anything else that needs to say what the door will do.
 *
 * MIRRORS THE SQL RULE FOR RULE, and that is the whole point of having it:
 * the function treats anything but `mode = 'round_robin'` with an `agents`
 * ARRAY as off, and ignores any agent id that is not an active member of the
 * org. So a row edited as raw JSON on /settings/cyprus-config shows here as
 * what the sweep will actually do — `round_robin` with nobody usable is shown
 * as round-robin with nobody ticked, not quietly as off.
 */

export const LEAD_ROUTING_MODES = ["off", "round_robin"] as const;
export type LeadRoutingMode = (typeof LEAD_ROUTING_MODES)[number];

export interface LeadRouting {
  mode: LeadRoutingMode;
  agents: string[];
}

const OFF: LeadRouting = { mode: "off", agents: [] };

export function readLeadRouting(value: unknown): LeadRouting {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...OFF };
  const v = value as Record<string, unknown>;
  const mode: LeadRoutingMode | null =
    v.mode === "round_robin" ? "round_robin" : v.mode === "off" ? "off" : null;
  if (!mode) return { ...OFF };
  const agents = Array.isArray(v.agents)
    ? v.agents.filter((a): a is string => typeof a === "string")
    : [];
  return { mode, agents };
}
