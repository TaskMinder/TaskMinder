import z from "zod";

export const getReviewPageSchema = z.object({
  params: z.object({
    id: z.coerce.number()
  }),
  query: z.object({
    token: z.string().max(256)
  }),
  body: z.unknown()
});

export const resolveReportSchema = z.object({
  params: z.object({
    id: z.coerce.number()
  }),
  query: z.object({}),
  body: z.strictObject({
    token: z.string().max(256),
    csrf: z.string(),
    action: z.enum(["dismiss", "remove", "ban", "remove_and_ban", "rotate_class_code"]),
    reason: z.string().trim().max(1000)
  })
});

export type getReviewPageTypeParams = z.infer<typeof getReviewPageSchema>["params"];
export type getReviewPageTypeQuery = z.infer<typeof getReviewPageSchema>["query"];
export type resolveReportTypeParams = z.infer<typeof resolveReportSchema>["params"];
export type resolveReportTypeBody = z.infer<typeof resolveReportSchema>["body"];
