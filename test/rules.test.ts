import { describe, expect, it } from "vitest";
import { fill, runSkill } from "../src/skills/rules.js";

describe("skill rules (skills2 language)", () => {
  it("fills templates with zero-pad, int and slice", () => {
    expect(fill("财务/发票/{y}-{m|02}", { y: "2026", m: "3" })).toBe("财务/发票/2026-03");
    expect(fill("{d}-{shop}-{amt|int}.pdf", { d: "20260305", shop: "京东", amt: "99.00" })).toBe("20260305-京东-99.pdf");
    expect(fill("{d[0:4]}", { d: "20260305" })).toBe("2026");
    expect(fill("{m|02}", { m: "１２" })).toBe("12");
  });

  it("translates Python named groups and matches case-insensitively", () => {
    const sk = { rules: [{ name: "inv", match: ["^发票_(?P<shop>[^_]+)_(?P<y>\\d{4})(?P<m>\\d{2})(?P<d>\\d{2})_(?P<amt>\\d+)元", "^INVOICE-(?P<shop>[a-z]+)-(?P<y>\\d{4})(?P<m>\\d{2})(?P<d>\\d{2})"], ext: ["pdf"], not: ["模板"], to: "财务/发票/{y}-{m}", rename: "{y}{m}{d}-{shop}-{amt|int}.pdf" }] };
    const { where, unsure } = runSkill(sk, ["发票_京东_20260305_99元.pdf", "发票模板.pdf", "invoice-jd-20260305.pdf", "todo.md"]);
    expect(where["发票_京东_20260305_99元.pdf"]).toBe("财务/发票/2026-03/20260305-京东-99.pdf");
    expect(where["发票模板.pdf"]).toBe("发票模板.pdf");
    expect(where["todo.md"]).toBe("todo.md");
    expect(unsure).toEqual(["invoice-jd-20260305.pdf"]);        // the rename needs amt, which this alternative lacks
  });

  it("needs both name and content when both are written, and merges their fields", () => {
    const sk = { rules: [{ name: "scan", match: ["^scan_\\d+"], content: ["价税合计[:：]?\\s*(?P<amt>\\d+)"], to: "发票", rename: "{amt|int}.pdf" }] };
    const { where } = runSkill(sk, ["scan_0012.pdf", "scan_0013.pdf"], { "scan_0012.pdf": "电子发票 价税合计：128.00", "scan_0013.pdf": "报价单" });
    expect(where["scan_0012.pdf"]).toBe("发票/128.pdf");
    expect(where["scan_0013.pdf"]).toBe("scan_0013.pdf");
  });

  it("keeps the newest per group and sends older versions elsewhere", () => {
    const sk = { rules: [{ name: "v", match: ["^(?P<proj>\\w+)_v(?P<ver>\\d+)\\.psd$"], to: "设计/{proj}", latest: { group: "proj", version: "ver", older_to: "设计/{proj}/旧版本" } }] };
    const { where } = runSkill(sk, ["logo_v1.psd", "logo_v3.psd", "logo_v2.psd"]);
    expect(where["logo_v3.psd"]).toBe("设计/logo/logo_v3.psd");
    expect(where["logo_v1.psd"]).toBe("设计/logo/旧版本/logo_v1.psd");
  });

  it("marks a file two rules claim as unsure", () => {
    const sk = { rules: [{ name: "a", match: ["x"], to: "A" }, { name: "b", match: ["x"], to: "B" }] };
    expect(runSkill(sk, ["x.txt"]).unsure).toEqual(["x.txt"]);
  });
});
