import * as dotenv from "dotenv";
dotenv.config();
import { prisma } from "../config/prisma.js";
import logger from "../config/logger.js";
import { createReviewLink } from "../services/report.service.js";

// fallback when a review mail got lost; actions are only possible through the review page
async function runModerationCli(): Promise<void> {
  const [command, id] = process.argv.slice(2);

  if (command === "list") {
    const reports = await prisma.report.findMany({
      where: { status: "open" },
      select: { reportId: true, category: true, targetType: true, createdAt: true },
      orderBy: { createdAt: "asc" }
    });
    for (const report of reports) {
      const ageHours = Math.floor((Date.now() - Number(report.createdAt)) / (60 * 60 * 1000));
      logger.info(`#${report.reportId}\t${report.category}\t${report.targetType}\t${ageHours}h`);
    }
    logger.info(`${reports.length} open report(s)`);
    return;
  }

  if (command === "link" && id) {
    const report = await prisma.report.findFirst({
      where: { reportId: Number(id), status: "open" },
      select: { reportId: true }
    });
    if (!report) {
      throw new Error(`No open report with id ${id}`);
    }
    logger.info(createReviewLink(report.reportId));
    return;
  }

  throw new Error("Usage: bun run moderation list | link <id>");
}

runModerationCli()
  .catch(error => {
    logger.error(`Moderation CLI failed: ${error}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
