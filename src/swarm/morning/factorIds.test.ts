import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
    REGISTRY_VERSION,
    REGISTRY_IDS,
    FACTOR_SPORTS,
    FACTOR_DEFAULT_WEIGHTS,
    FACTOR_CAP,
    FACTOR_TOTAL_CAP,
    FACTOR_MAX_PER_JUDGMENT,
    FACTOR_EVIDENCE_KINDS,
    FACTOR_URL_HOSTS,
    isJudgmentFactors,
    isAllowedEvidenceUrl,
} from "./factorIds.ts";

// factor_registry.v1.json is the copy kept byte-identical in DuelOdds.
const reg = JSON.parse(
    readFileSync(fileURLToPath(new URL("./factor_registry.v1.json", import.meta.url)), "utf8"),
);

describe("factor registry parity (factor_registry.v1.json)", () => {
    it("constants equal the shared JSON exactly", () => {
        expect(reg.registryVersion).toBe(REGISTRY_VERSION);
        expect(reg.ids).toEqual([...REGISTRY_IDS]);
        expect(reg.sports).toEqual(Object.fromEntries(Object.entries(FACTOR_SPORTS).map(([k, v]) => [k, [...v]])));
        expect(reg.defaultWeights).toEqual(FACTOR_DEFAULT_WEIGHTS);
        expect(reg.factorCap).toBe(FACTOR_CAP);
        expect(reg.totalCap).toBe(FACTOR_TOTAL_CAP);
        expect(reg.maxFactors).toBe(FACTOR_MAX_PER_JUDGMENT);
        expect(reg.evidenceKinds).toEqual([...FACTOR_EVIDENCE_KINDS]);
        expect(reg.urlHosts).toEqual([...FACTOR_URL_HOSTS]);
    });

    it("every id has sports and a weight; ids are unique", () => {
        expect(new Set(REGISTRY_IDS).size).toBe(REGISTRY_IDS.length);
        expect(Object.keys(FACTOR_SPORTS).sort()).toEqual([...REGISTRY_IDS].sort());
        expect(Object.keys(FACTOR_DEFAULT_WEIGHTS).sort()).toEqual([...REGISTRY_IDS].sort());
    });

    it("defaults match the DuelOdds side: weights 0.05-0.10, cap 0.15 each, 0.35 total", () => {
        for (const w of Object.values(FACTOR_DEFAULT_WEIGHTS)) {
            expect(w).toBeGreaterThanOrEqual(0.05);
            expect(w).toBeLessThanOrEqual(0.1);
            expect(w).toBeLessThanOrEqual(FACTOR_CAP);
        }
        expect(FACTOR_CAP).toBe(0.15);
        expect(FACTOR_TOTAL_CAP).toBe(0.35);
    });
});

describe("JUDGMENT_FACTORS flag and url allow-list", () => {
    it("is off by default", () => {
        expect(isJudgmentFactors(undefined)).toBe(false);
        expect(isJudgmentFactors({})).toBe(false);
        expect(isJudgmentFactors({ JUDGMENT_FACTORS: "yes" })).toBe(false);
        expect(isJudgmentFactors({ JUDGMENT_FACTORS: "1" })).toBe(true);
        expect(isJudgmentFactors({ JUDGMENT_FACTORS: " TRUE " })).toBe(true);
    });

    it("allows only https on the listed hosts", () => {
        expect(isAllowedEvidenceUrl("https://www.espn.com/nfl/injuries")).toBe(true);
        expect(isAllowedEvidenceUrl("https://api.weather.gov/points/39.1,-94.5")).toBe(true);
        expect(isAllowedEvidenceUrl("https://api.open-meteo.com/v1/forecast")).toBe(true);
        expect(isAllowedEvidenceUrl("http://www.espn.com/x")).toBe(false);
        expect(isAllowedEvidenceUrl("https://evilespn.com/x")).toBe(false);
        expect(isAllowedEvidenceUrl("https://espn.com.evil.io/x")).toBe(false);
        expect(isAllowedEvidenceUrl("not a url")).toBe(false);
    });
});

describe("JUDGE_MANAGER_INSTRUCTION_V2_FACTORS", () => {
    it("lists every registry id and stays within the v1 instruction length (Groq TPM)", async () => {
        const p = await import("./judgePrompt.ts");
        for (const id of REGISTRY_IDS) expect(p.JUDGE_MANAGER_INSTRUCTION_V2_FACTORS).toContain(id);
        expect(p.JUDGE_MANAGER_INSTRUCTION_V2_FACTORS).toContain('"factors"');
        expect(p.JUDGE_MANAGER_INSTRUCTION_V2_FACTORS.length).toBeLessThanOrEqual(p.JUDGE_MANAGER_INSTRUCTION.length);
        expect(p.JUDGE_MANAGER_INSTRUCTION_V2).not.toContain("factors");
    });
});
