import { userInfo } from "node:os";
import { join } from "node:path";
import { launchBrowser } from "./runtime.js";

const runtime = await launchBrowser({
  profileDirectory: join(userInfo().homedir, ".openapply-agent", "browser-profile"),
  headless: false,
});

console.log("Owned browser opened. Sign in to job boards, then press Ctrl+C here to save and close the profile.");
const page = runtime.context.pages()[0] ?? await runtime.context.newPage();
await Promise.race([
  new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  }),
  page.waitForEvent("close", { timeout: 0 }),
]);
await runtime.close();
