import z from "zod";

export const reportTargetTypeField = z.enum(["homework", "event", "upload", "account", "class"]);

export const createReportSchema = z.object({
  params: z.object({}),
  query: z.object({}),
  body: z.strictObject({
    targetType: reportTargetTypeField,
    targetId: z.coerce.number(),
    // "block" is reserved for reports filed by blocking
    category: z.enum(["illegal", "harassment", "hate", "sexual", "spam", "privacy", "other"]),
    description: z.string().trim().max(1000).optional(),
    contactEmail: z.email().max(254).optional()
  })
});

export type createReportTypeBody = z.infer<typeof createReportSchema>["body"];
