import { startSetupUi } from "./ui.js";
import { bundledTemplateRoot } from "./init.js";

const ui = await startSetupUi({ repositoryRoot: bundledTemplateRoot(),
  ...(process.env.OPENAPPLY_SETUP_DIR ? { destination: process.env.OPENAPPLY_SETUP_DIR } : {}) });
console.log(`Open private setup: ${ui.url}`);
console.log("Press Ctrl+C to stop the local setup server.");
