import { describe, expect, it } from "vitest";
import { LEAD_ROUTING_MODES, readLeadRouting } from "./lead-routing";

/**
 * The app's reader of `cyprus_config.lead_routing` (0098, audit LR-05),
 * mirroring the SQL function's rule: anything but a well-formed
 * {mode: round_robin, agents: [...]} means OFF. The settings page shows what
 * the door will actually do, including when someone has edited the row as
 * raw JSON on /settings/cyprus-config.
 */
describe("readLeadRouting", () => {
  it("reads a well-formed rule", () => {
    expect(readLeadRouting({ mode: "round_robin", agents: ["a", "b"] })).toEqual({
      mode: "round_robin",
      agents: ["a", "b"],
    });
    expect(readLeadRouting({ mode: "off", agents: [] })).toEqual({ mode: "off", agents: [] });
  });

  it("falls back to off for a missing row, garbage, or an unknown mode", () => {
    expect(readLeadRouting(null)).toEqual({ mode: "off", agents: [] });
    expect(readLeadRouting(undefined)).toEqual({ mode: "off", agents: [] });
    expect(readLeadRouting("round_robin")).toEqual({ mode: "off", agents: [] });
    expect(readLeadRouting({ mode: "random", agents: ["a"] })).toEqual({ mode: "off", agents: [] });
  });

  it("keeps only string agent ids, and reads a rule with no usable agent as it is", () => {
    expect(readLeadRouting({ mode: "round_robin", agents: ["a", 3, null, "b"] })).toEqual({
      mode: "round_robin",
      agents: ["a", "b"],
    });
    // the SQL side assigns nobody in that case; the page must SHOW round_robin
    // with nobody ticked rather than pretend the rule is off
    expect(readLeadRouting({ mode: "round_robin", agents: "a" })).toEqual({
      mode: "round_robin",
      agents: [],
    });
  });

  it("names the two modes the migration seeded and the settings form offers", () => {
    expect(LEAD_ROUTING_MODES).toEqual(["off", "round_robin"]);
  });
});
