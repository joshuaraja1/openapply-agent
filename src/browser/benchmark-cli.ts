import { benchmarkOwnedBrowser } from "./benchmark.js";

const argument = process.argv[2] === "browser:benchmark" ? process.argv[3] : process.argv[2];
const count = argument === undefined ? 30 : Number(argument);
const report = await benchmarkOwnedBrowser(count);
console.log(JSON.stringify(report, null, 2));
if (report.snapshot.failures || report.actionAndSnapshot.failures) process.exitCode = 1;
