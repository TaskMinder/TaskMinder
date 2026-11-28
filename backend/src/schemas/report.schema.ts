import z from "zod";
import { ReportCategory, ReportTargetType } from "../prisma/generated/prisma/enums.js";

export const createReportSchema = z.object({
  params: z.object({}),
  query: z.object({}),
  body: z.strictObject({
    targetType: z.enum(ReportTargetType),
    targetId: z.coerce.number(),
    category: z.enum(ReportCategory),
    description: z.string().trim().max(1000).optional(),
    contactEmail: z.email().max(254).optional()
  })
});

export type createReportTypeBody = z.infer<typeof createReportSchema>["body"];
