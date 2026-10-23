import z from "zod";

export const setLessonDataSchema = z.object({
  params: z.object({}),
  query: z.object({}),
  body: z.strictObject({
    lessons: z.array(
      z.object({
        lessonNumber: z.coerce.number().min(1),
        weekDay: z.coerce.number().int().min(0).max(4),
        teamId: z.coerce.number(),
        subjectId: z.coerce.number(),
        room: z.string().max(256),
        startTime: z.coerce.number(),
        endTime: z.coerce.number()
      })
    )
  })
});

export type setLessonDataTypeBody = z.infer<typeof setLessonDataSchema>["body"];