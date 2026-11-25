import { z } from "zod";

export const browserPlatformSchema = z.enum(["linkedin", "jobright", "handshake", "generic"]);

export const browserSearchInputSchema = z.object({
  runtime: z.enum(["browseros", "owned"]).default("browseros"),
  endpoint: z.string().url().default("http://127.0.0.1:9010/mcp"),
  searches: z.array(z.object({
    label: z.string().min(1),
    platform: browserPlatformSchema,
    url: z.string().url(),
    enabled: z.boolean().default(true),
  })).min(1),
});

export type BrowserPlatform = z.infer<typeof browserPlatformSchema>;
export type BrowserSearchInput = z.infer<typeof browserSearchInputSchema>;

export interface BrowserLead {
  platform: BrowserPlatform;
  title: string;
  url: string;
  sourceSearchUrl: string;
  observedAt: string;
}
