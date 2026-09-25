import { Injectable } from "@nestjs/common";
import nodemailer from "nodemailer";
import { PrismaService } from "../../infra/prisma.service.js";

@Injectable()
export class MailService {
  constructor(private readonly prisma: PrismaService) {}
  async sendMeetingSummary(meetingId: string, title: string, risks: Array<{ description: string }>, todos: Array<{ title: string; owner: string }>) {
    const mock = process.env.SMTP_PROVIDER === "mock";
    const recipient = process.env.SMTP_TO ?? (mock ? "demo@example.test" : "");
    if (process.env.SMTP_ENABLED !== "true" || !recipient || (!mock && !process.env.SMTP_HOST)) {
      return this.prisma.emailDelivery.create({ data: { meetingId, recipientMasked: this.mask(recipient), status: "DISABLED", errorCode: "SMTP_NOT_CONFIGURED" } });
    }
    const delivery = await this.prisma.emailDelivery.create({ data: { meetingId, recipientMasked: this.mask(recipient), status: "PENDING" } });
    if (mock) return this.prisma.emailDelivery.update({ where: { id: delivery.id }, data: { status: "SENT", attempts: 1, sentAt: new Date() } });
    try {
      const transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 587), secure: Number(process.env.SMTP_PORT) === 465,
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
      });
      const html = `<h2>${this.escape(title)}</h2><h3>风险</h3><ul>${risks.map((r) => `<li>${this.escape(r.description)}</li>`).join("")}</ul><h3>待办</h3><ul>${todos.map((t) => `<li>${this.escape(t.title)}（${this.escape(t.owner)}）</li>`).join("")}</ul>`;
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await transport.sendMail({ from: process.env.SMTP_FROM, to: recipient, subject: `[NBBOSS] ${title} 风险与待办汇总`, html });
          return this.prisma.emailDelivery.update({ where: { id: delivery.id }, data: { status: "SENT", attempts: attempt, sentAt: new Date() } });
        } catch (error) {
          lastError = error;
          await this.prisma.emailDelivery.update({ where: { id: delivery.id }, data: { attempts: attempt } });
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
        }
      }
      throw lastError;
    } catch (error) {
      return this.prisma.emailDelivery.update({ where: { id: delivery.id }, data: { status: "FAILED", errorCode: error instanceof Error ? error.name : "SMTP_ERROR" } });
    }
  }
  private mask(value: string) { if (!value.includes("@")) return value ? "***" : ""; const [name, domain] = value.split("@"); return `${name.slice(0, 2)}***@${domain}`; }
  private escape(value: string) { return value.replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m]!); }
}
