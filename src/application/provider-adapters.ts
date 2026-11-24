import type { CandidateProfile } from "../candidate/schema.js";
import type { Provider } from "../types.js";

type IdentityKey = "fullName" | "email" | "phone" | "location" | "linkedin" | "github" | "portfolio";

// These are exact, low-risk identity aliases allowed for ATS forms. Unknown
// questions remain for human review; provider selection never supplies an answer.
const aliases: Partial<Record<Provider, Readonly<Record<string, IdentityKey>>>> = {
  greenhouse: {
    "linkedin profile": "linkedin",
    "linkedin profile url": "linkedin",
    "github profile": "github",
    "github profile url": "github",
    "website url": "portfolio",
    "portfolio url": "portfolio",
  },
  ashby: {
    "your name": "fullName",
    "your email": "email",
    "your phone number": "phone",
    "your linkedin profile": "linkedin",
    "your linkedin profile url": "linkedin",
    "your github profile": "github",
    "personal website url": "portfolio",
  },
};

export function providerIdentityValue(
  provider: Provider | undefined, label: string, candidate: CandidateProfile,
): string | undefined {
  if (!provider || !aliases[provider]) return undefined;
  const key = aliases[provider][label.toLowerCase().replace(/[*:]+$/, "").trim()];
  return key ? candidate.identity[key] : undefined;
}
