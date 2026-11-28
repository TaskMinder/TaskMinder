import z from "zod";
import { DecisionGround } from "../prisma/generated/prisma/enums.js";

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

export const getReportFileSchema = z.object({
  params: z.object({
    id: z.coerce.number(),
    fileId: z.coerce.number()
  }),
  query: z.object({}),
  body: z.unknown()
});

// restricting actions need ground and reason (DSA Art. 17(3)(d), (e))
const restrictionFields = {
  ground: z.enum(DecisionGround),
  reason: z.string().trim().min(1).max(1000)
};

const rotateClassCodeField = { rotateClassCode: z.boolean().optional() };

export const resolveReportSchema = z.object({
  params: z.object({
    id: z.coerce.number()
  }),
  query: z.object({}),
  body: z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("dismiss"), reason: z.string().trim().max(1000) }),
    z.strictObject({ action: z.literal("rotate_class_code"), ...restrictionFields }),
    z.strictObject({ action: z.literal("remove"), ...restrictionFields, ...rotateClassCodeField }),
    z.strictObject({
      action: z.literal(["ban", "remove_and_ban"]),
      ...restrictionFields,
      banTarget: z.enum(["author", "editor"]),
      ...rotateClassCodeField
    })
  ])
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
export type getReportFileTypeParams = z.infer<typeof getReportFileSchema>["params"];
export type resolveReportTypeParams = z.infer<typeof resolveReportSchema>["params"];
export type resolveReportTypeBody = z.infer<typeof resolveReportSchema>["body"];
export type unbanAccountTypeParams = z.infer<typeof unbanAccountSchema>["params"];
export type BanDecision = Extract<resolveReportTypeBody, { banTarget: unknown }>;
