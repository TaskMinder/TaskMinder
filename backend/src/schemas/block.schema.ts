import z from "zod";
import { reportTargetTypeField } from "./report.schema.js";

export const addBlockSchema = z.object({
  params: z.object({}),
  query: z.object({}),
  body: z.union([
    z.strictObject({
      accountId: z.coerce.number()
    }),
    z.strictObject({
      targetType: reportTargetTypeField,
      targetId: z.coerce.number()
    })
  ])
});

export const deleteBlockSchema = z.object({
  params: z.object({
    accountId: z.coerce.number()
  }),
  query: z.object({}),
  body: z.unknown()
});

export type addBlockTypeBody = z.infer<typeof addBlockSchema>["body"];
export type deleteBlockTypeParams = z.infer<typeof deleteBlockSchema>["params"];
