import { userInfo } from "node:os";
import { join } from "node:path";
import { checkOwnedBrowser } from "./doctor.js";

const profileDirectory = join(userInfo().homedir, ".openapply-agent", "browser-profile");
console.log(JSON.stringify(await checkOwnedBrowser(profileDirectory)));
