import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import upstream from "@/lib/humanizer/upstream.json";
import { HUMANIZER_SKILL_MD } from "@/lib/humanizer/skill.generated";
import {
  HUMANIZER_MCP_GUIDANCE,
  HUMANIZER_SKILL_BODY,
  HUMANIZER_VERSION,
  humanizerGenerationBlock,
  humanizerPatterns,
} from "@/lib/humanizer";
import { buildStyleSystem } from "@/lib/ai/generate";
import { validateSkill } from "../../../scripts/humanizer-sync.mjs";

describe("vendored Humanizer skill", () => {
  it("is exactly what humanizer-sync recorded (no hand edits)", () => {
    expect(createHash("sha256").update(HUMANIZER_SKILL_MD).digest("hex")).toBe(upstream.skill_sha256);
    expect(validateSkill(HUMANIZER_SKILL_MD).version).toBe(upstream.version);
  });

  it("numbers its patterns 1..N without gaps", () => {
    const patterns = humanizerPatterns();
    expect(patterns).toHaveLength(upstream.pattern_count);
    patterns.forEach((p, i) => expect(p.startsWith(`${i + 1}. `)).toBe(true));
  });

  it("drops the frontmatter from the body", () => {
    expect(HUMANIZER_SKILL_BODY.startsWith("---")).toBe(false);
    expect(HUMANIZER_SKILL_BODY).toContain("# Humanizer");
  });

  it("refuses text that isn't the skill", () => {
    expect(() => validateSkill("# not a skill")).toThrow(/frontmatter/);
    expect(() => validateSkill('---\nname: x\nmetadata:\n  version: "1.0.0"\n---\n# x\n')).toThrow(/patterns/);
  });
});

describe("Humanizer in web generation", () => {
  it("carries the version and every pattern in the MCP short form", () => {
    for (const p of humanizerPatterns()) expect(HUMANIZER_MCP_GUIDANCE).toContain(p);
    expect(HUMANIZER_MCP_GUIDANCE).toContain(`v${HUMANIZER_VERSION}`);
  });

  it("ends every web-generation system prompt, after the guides, the same bytes each time", () => {
    const system = buildStyleSystem("BRAND", "AUTHOR");
    expect(system.endsWith(humanizerGenerationBlock())).toBe(true);
    expect(system.indexOf("AUTHOR")).toBeLessThan(system.indexOf("<humanizer"));
    expect(buildStyleSystem(null, null)).toContain(HUMANIZER_SKILL_BODY);
    expect(buildStyleSystem("BRAND", "AUTHOR")).toBe(system);
  });
});
