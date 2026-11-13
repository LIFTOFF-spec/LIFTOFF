import { describe, expect, it } from "vitest";
import {
  classifyRisk,
  levenshtein,
  nameSimilarity,
  normalizeName,
  normalizeTelegram,
  normalizeWebsite,
  normalizeXAccount,
  type RiskIndicator,
} from "./copycat";
import { ANTI_COPYCAT_CONFIG } from "./launch-config";

const ind = (code: RiskIndicator["code"]): RiskIndicator => ({
  code,
  field: "name",
  weight: ANTI_COPYCAT_CONFIG.riskWeights[code],
  message: code,
  relatedTicker: null,
});

describe("classifyRisk (Spec §7)", () => {
  const t = ANTI_COPYCAT_CONFIG;
  it("tanpa indikator → Low", () => {
    expect(classifyRisk([], t)).toMatchObject({ level: "low", score: 0 });
  });
  it("ticker berulang saja → Medium, bukan penipuan otomatis", () => {
    expect(classifyRisk([ind("ticker_repeated")], t).level).toBe("medium");
  });
  it("branding mirip (nama atau gambar) saja → Medium", () => {
    expect(classifyRisk([ind("name_similar")], t).level).toBe("medium");
    expect(classifyRisk([ind("image_similar")], t).level).toBe("medium");
  });
  it("beberapa indikator → High", () => {
    expect(classifyRisk([ind("ticker_repeated"), ind("name_identical")], t).level).toBe("high");
    expect(classifyRisk([ind("ticker_repeated"), ind("image_similar")], t).level).toBe("high");
  });
  it("akun X / website yang dipakai token lain → High sendiri (peniruan langsung)", () => {
    expect(classifyRisk([ind("social_x_reused")], t).level).toBe("high");
    expect(classifyRisk([ind("social_website_reused")], t).level).toBe("high");
  });
});

describe("kemiripan nama", () => {
  it("normalizeName melipat homoglyph, leet, dan kata generik", () => {
    expect(normalizeName("Pepe Coin")).toBe(normalizeName("PEPE"));
    expect(normalizeName("P3PE Official Token")).toBe(normalizeName("pepe"));
    expect(normalizeName("Ꮲepe")).not.toBe(""); // tidak crash untuk huruf asing
  });
  it("levenshtein", () => {
    expect(levenshtein("rocket", "rocket")).toBe(0);
    expect(levenshtein("rocket", "rockets")).toBe(1);
    expect(levenshtein("", "abc")).toBe(3);
  });
  it("nameSimilarity: identik 1, salah ketik tinggi, berbeda rendah", () => {
    expect(nameSimilarity("Rocket Inu", "ROCKET")).toBe(1);
    expect(nameSimilarity("Moonrocket", "Moonrockets")).toBeGreaterThanOrEqual(
      ANTI_COPYCAT_CONFIG.nameSimilarityThreshold,
    );
    expect(nameSimilarity("Banana", "Rocket")).toBeLessThan(0.5);
  });
});

describe("normalisasi tautan sosial", () => {
  it("akun X dari handle atau URL", () => {
    expect(normalizeXAccount("@LiftOff_Sol")).toBe("liftoff_sol");
    expect(normalizeXAccount("https://x.com/LiftOff_Sol")).toBe("liftoff_sol");
    expect(normalizeXAccount("https://twitter.com/liftoff_sol/status/1")).toBe("liftoff_sol");
    expect(normalizeXAccount("not a handle!")).toBeNull();
    expect(normalizeXAccount("")).toBeNull();
  });
  it("website tanpa www, query, atau / di akhir", () => {
    expect(normalizeWebsite("https://www.Rocket.io/")).toBe("rocket.io");
    expect(normalizeWebsite("https://rocket.io/?ref=1")).toBe("rocket.io");
    expect(normalizeWebsite("https://rocket.io/team")).toBe("rocket.io/team");
  });
  it("telegram t.me / telegram.me", () => {
    expect(normalizeTelegram("https://t.me/RocketChat")).toBe("rocketchat");
    expect(normalizeTelegram("https://telegram.me/rocketchat/")).toBe("rocketchat");
  });
});
