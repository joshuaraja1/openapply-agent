import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { ensurePrivateDirectory } from "../storage/private-path.js";
import { bundledTemplateRoot, initializeUserWorkspace } from "./init.js";

const home = join(userInfo().homedir, ".openapply-agent");
const destination = process.env.OPENAPPLY_SETUP_DIR ?? join(home, "onboarding");
if (!isAbsolute(destination)) throw new Error("OPENAPPLY_SETUP_DIR must be an absolute private path");
if (!process.env.OPENAPPLY_SETUP_DIR) await ensurePrivateDirectory(home);
const created = await initializeUserWorkspace(destination, bundledTemplateRoot());
console.log(JSON.stringify({ onboardingDirectory: destination, created,
  next: "Complete templates 01–03, then run profile:compile; configure your own accounts and optional mailbox OAuth." }));
