import { z } from "zod";
import { jobSchema } from "../application/runner.js";
import { candidateProfileSchema } from "../candidate/schema.js";
import { sourceSchema } from "../config.js";

export const renderInputSchema = z.object({
  version: z.literal(1), job: jobSchema, source: sourceSchema, candidate: candidateProfileSchema,
  browserRuntime: z.enum(["browseros", "owned"]).default("browseros"),
  browserEndpoint: z.url().optional(), overleafProjectUrl: z.url(), outputDirectory: z.string().min(1),
  requireFinalApproval: z.boolean().default(true), expectedConfirmation: z.string().min(1).optional(),
}).superRefine((input, context) => {
  if (input.browserRuntime === "browseros" && !input.browserEndpoint) {
    context.addIssue({ code: "custom", message: "BrowserOS rendering requires browserEndpoint" });
  }
  if (input.browserRuntime === "owned" && input.browserEndpoint) {
    context.addIssue({ code: "custom", message: "Owned rendering must not set browserEndpoint" });
  }
});

