import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchService } from "../src/modules/search/search.service.js";
import { MailService } from "../src/modules/mail/mail.service.js";
import nodemailer from "nodemailer";

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });

describe("provider adapters", () => {
  it("reports search unavailable without configuration", async () => {
    process.env.SEARCH_ENABLED = "false";
    const search = new SearchService();
    expect(search.available()).toBe(false);
    await expect(search.search("test")).rejects.toMatchObject({ status: 503 });
  });

  it("provides deterministic search results in mock mode", async () => {
    process.env.SEARCH_ENABLED = "true"; process.env.SEARCH_PROVIDER = "mock"; delete process.env.SEARCH_API_KEY;
    const result = await new SearchService().search("NBBOSS");
    expect(result[0]?.url).toContain("example.test");
    expect(result[0]?.retrievedAt).toBeTruthy();
  });

  it("drops non-HTTP URLs returned by a search provider", async () => {
    process.env.SEARCH_ENABLED = "true"; process.env.SEARCH_PROVIDER = "tavily"; process.env.SEARCH_API_KEY = "test";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ results: [
      { title: "unsafe", url: "javascript:alert(1)", content: "x" },
      { title: "safe", url: "https://example.test/source", content: "ok" },
    ] }), { status: 200, headers: { "content-type": "application/json" } }));
    const results = await new SearchService().search("test");
    expect(results).toEqual([expect.objectContaining({ title: "safe", url: "https://example.test/source" })]);
  });

  it("records disabled and mock-sent email states", async () => {
    const create = vi.fn(async ({ data }: any) => ({ id: "mail-1", ...data }));
    const update = vi.fn(async ({ data }: any) => ({ id: "mail-1", ...data }));
    const mail = new MailService({ emailDelivery: { create, update } } as any);
    process.env.SMTP_ENABLED = "false";
    expect((await mail.sendMeetingSummary("m1", "周会", [], [])).status).toBe("DISABLED");
    process.env.SMTP_ENABLED = "true"; process.env.SMTP_PROVIDER = "mock"; delete process.env.SMTP_TO;
    expect((await mail.sendMeetingSummary("m1", "周会", [], [])).status).toBe("SENT");
    expect(update).toHaveBeenCalledOnce();
  });

  it("retries SMTP failures three times and persists only a masked failure code", async () => {
    vi.useFakeTimers();
    const create = vi.fn(async ({ data }: any) => ({ id: "mail-2", ...data }));
    const update = vi.fn(async ({ data }: any) => ({ id: "mail-2", ...data }));
    const sendMail = vi.fn(async () => { throw new Error("secret smtp diagnostic"); });
    vi.spyOn(nodemailer, "createTransport").mockReturnValue({ sendMail } as any);
    process.env.SMTP_ENABLED = "true";
    process.env.SMTP_PROVIDER = "smtp";
    process.env.SMTP_HOST = "smtp.example.test";
    process.env.SMTP_TO = "employee@example.test";
    const promise = new MailService({ emailDelivery: { create, update } } as any)
      .sendMeetingSummary("m1", "<周会>", [{ description: "风险" }], [{ title: "待办", owner: "王芳" }]);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(sendMail).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ status: "FAILED", errorCode: "Error" });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ attempts: 3 }) }));
    expect(JSON.stringify(update.mock.calls)).not.toContain("secret smtp diagnostic");
    vi.useRealTimers();
  });
});
