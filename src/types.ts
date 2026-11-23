export type Provider = "greenhouse" | "ashby" | "workday" | "lever" | "smartrecruiters" | "jsonld";

export interface NormalizedJob {
  id: string;
  provider: Provider;
  company: string;
  title: string;
  location: string | null;
  department: string | null;
  employmentType: string | null;
  workplaceType: string | null;
  compensation: string | null;
  descriptionText: string;
  applicationUrl: string;
  sourceUrl: string;
  sourcePublishedAt: string | null;
  sourceUpdatedAt: string | null;
}

export interface DiscoveredJob extends NormalizedJob {
  firstSeenAt: string;
  discoveredAt: string;
  isNew: boolean;
  isFresh: boolean;
  freshnessBasis: "source-published" | "first-seen";
  matchedKeywords: string[];
}

export interface DiscoveryState {
  jobs: Record<string, { firstSeenAt: string; lastSeenAt: string; reportedAt?: string }>;
}
