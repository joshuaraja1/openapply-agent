import { startSetupUi } from "./ui.js";

const ui = await startSetupUi({ repositoryRoot: process.cwd(),
  ...(process.env.OPENAPPLY_SETUP_DIR ? { destination: process.env.OPENAPPLY_SETUP_DIR } : {}) });
console.log(`Open private setup: ${ui.url}`);
console.log("Press Ctrl+C to stop the local setup server.");
