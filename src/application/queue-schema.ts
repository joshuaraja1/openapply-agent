import { z } from "zod";
import { sourceSchema } from "../config.js";
import { jobSchema } from "./runner.js";

export const queueFileSchema = z.object({ queue: z.array(z.object({ job: jobSchema,
  source: sourceSchema.optional(),
  // Legacy entries lack a fresh official-source verification marker.
  sourceVerification: z.enum(["verified", "unavailable"]).default("unavailable"),
})) });
