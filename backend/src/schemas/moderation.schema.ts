import z from "zod";

// JSON API of the moderation panel (frontend/src/pages/moderation); the CSRF token comes in the X-CSRF-Token header

export const loginSchema = z.object({
  params: z.object({}),
  query: z.object({}),
  body: z.strictObject({
    password: z.string().max(256)
  })
});

export const getReportSchema = z.object({
  params: z.object({
    id: z.coerce.number()
  }),
  query: z.object({}),
  body: z.unknown()
});

export const resolveReportSchema = z.object({
  params: z.object({
    id: z.coerce.number()
  }),
  query: z.object({}),
  body: z.strictObject({
    action: z.enum(["dismiss", "remove", "ban", "remove_and_ban", "rotate_class_code"]),
    // ground of the statement of reasons (DSA Art. 17(3)(d), (e)); required for every action but dismiss
    ground: z.enum(["terms", "illegal"]).optional(),
    reason: z.string().trim().max(1000),
    // which account a ban hits; sent by the ban forms
    banTarget: z.enum(["author", "editor"]).optional(),
    rotateClassCode: z.boolean().optional()
  })
});

export const unbanAccountSchema = z.object({
  params: z.object({
    id: z.coerce.number()
  }),
  query: z.object({}),
  body: z.unknown()
});

export type loginTypeBody = z.infer<typeof loginSchema>["body"];
export type getReportTypeParams = z.infer<typeof getReportSchema>["params"];
export type resolveReportTypeParams = z.infer<typeof resolveReportSchema>["params"];
export type resolveReportTypeBody = z.infer<typeof resolveReportSchema>["body"];
export type unbanAccountTypeParams = z.infer<typeof unbanAccountSchema>["params"];
