import { z } from "zod";
import { sourceSchema } from "../config.js";
import { jobSchema } from "./runner.js";

export const queueFileSchema = z.object({ queue: z.array(z.object({ job: jobSchema,
  source: sourceSchema.optional() })) });
