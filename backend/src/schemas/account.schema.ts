import z from "zod";
import { checkUsername } from "../utils/validate.functions.js";
import { envConfig } from "../config/env.js";

const isDevelopment = envConfig.nodeEnv === "DEVELOPMENT";

export const passwordSchema = z
  .string()
  .min(6, "Password must be at least 6 characters long")
  .max(128, "Password must not exceed 128 characters")
  .regex(/[a-zA-Z]/, "Password must contain at least one letter")
  .regex(/[0-9]/, "Password must contain at least one number")
  .regex(/[^a-zA-Z0-9]/, "Password must contain at least one special character");

export const registerAccountSchema = z.object({
  params: z.object({}),
  query: z.object({}),
  body: z.strictObject({
    username: z.string().refine(checkUsername, {
      message: "Username must be 4-20 characters, letters, digits, or underscore only"
    }),
    password: passwordSchema
  }).refine(body => {
    // disable this check if in development
    if (isDevelopment) {
      return true;
    }
    return !(body.password.toLowerCase().includes(body.username.toLowerCase()));
  }, {
    message: "Password cannot contain username"
  })
});

export const loginAccountSchema = z.object({
  params: z.object({}),
  query: z.object({}),
  body: z.strictObject({
    username: z.string().refine(checkUsername, {
      message: "Username must be 4-20 characters, letters, digits, or underscore only"
    }),
    password: z.string().trim().min(4)
  }) // do not enforce password musnt contain username 
  // since we don't know if old accounts have this, thus preventing them from logging in
});

export const deleteAccountSchema = z.object({
  params: z.object({}),
  query: z.object({}),
  body: z.strictObject({
    password: z.string().trim().min(4)
  })
});

export const changeUsernameSchema = z.object({
  params: z.object({}),
  query: z.object({}),
  body: z.strictObject({
    password: z.string().trim().min(4),
    newUsername: z.string().refine(checkUsername, {
      message: "Username must be 4-20 characters, letters, digits, or underscore only"
    })
  }).refine(body => {
    // disable this check if in development
    if (isDevelopment) {
      return true;
    }
    return !(body.password.toLowerCase().includes(body.newUsername.toLowerCase()));
  }, {
    message: "Password cannot contain username"
  })
});

export const changePasswordSchema = z.object({
  params: z.object({}),
  query: z.object({}),
  body: z.strictObject({
    oldPassword: z.string().trim().min(4),
    newPassword: passwordSchema
  }) // checking if newPassword contains username is checked in service
  // since we do not have access to the username here
});

export const checkUsernameSchema = z.object({
  // omit body due to GET request
  params: z.object({}),
  query: z.object({
    // old usernames were always checked with checkUsername at login/register
    // so adding checkUsername check here does not hurt anything
    username: z.string().refine(checkUsername, {
      message: "Username must be 4-20 characters, letters, digits, or underscore only"
    })
  })
});

export const markNoticeSeenSchema = z.object({
  params: z.object({
    id: z.coerce.number()
  }),
  query: z.object({}),
  body: z.unknown()
});

export type checkUsernameTypeQuery = z.infer<typeof checkUsernameSchema>["query"];
export type markNoticeSeenTypeParams = z.infer<typeof markNoticeSeenSchema>["params"];

export type registerAccountTypeBody = z.infer<typeof registerAccountSchema>["body"];
export type loginAccountTypeBody = z.infer<typeof loginAccountSchema>["body"];
export type deleteAccountTypeBody = z.infer<typeof deleteAccountSchema>["body"];
export type changeUsernameTypeBody = z.infer<typeof changeUsernameSchema>["body"];
export type changePasswordTypeBody = z.infer<typeof changePasswordSchema>["body"];
