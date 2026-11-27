import { describe, expect, it } from "vitest";
import { syntheticCheckpoint, syntheticCrashStage } from "../src/cloud/synthetic-fault-probe.js";

const fixture = { provider: "synthetic", employerId: "fixture", requisitionId: "alpha" };
const guarded = { OPENAPPLY_CLOUD_TASK_MODE: "synthetic",
  OPENAPPLY_CLOUD_SYNTHETIC_ONLY: "1", OPENAPPLY_ENABLE_CLOUD_QUEUE_TASK: "1",
  OPENAPPLY_SUBMISSION_MODE: "disabled" };

describe("synthetic Fargate crash checkpoints", () => {
  it("accepts only explicit guarded stages", () => {
    for (const stage of ["after_intent", "after_click", "after_confirmation"] as const) {
      expect(syntheticCrashStage({ ...guarded, OPENAPPLY_SYNTHETIC_CRASH_AT: stage })).toBe(stage);
    }
    expect(syntheticCrashStage(guarded)).toBeUndefined();
    expect(() => syntheticCrashStage({ ...guarded, OPENAPPLY_SYNTHETIC_CRASH_AT: "submit" }))
      .toThrow();
    expect(() => syntheticCrashStage({ ...guarded, OPENAPPLY_SUBMISSION_MODE: "enabled",
      OPENAPPLY_SYNTHETIC_CRASH_AT: "after_click" })).toThrow("unavailable");
  });

  it("exits at only the selected fixture stage and rejects real jobs", () => {
    const exits: number[] = [];
    const exit = (code: number): never => { exits.push(code); throw new Error("task exited"); };
    const env = { ...guarded, OPENAPPLY_SYNTHETIC_CRASH_AT: "after_click" };
    syntheticCheckpoint("after_intent", fixture, env, exit);
    expect(exits).toEqual([]);
    expect(() => syntheticCheckpoint("after_click", fixture, env, exit))
      .toThrow("task exited");
    expect(exits).toEqual([86]);
    expect(() => syntheticCheckpoint("after_click", { ...fixture, provider: "greenhouse" },
      env, exit)).toThrow();
    expect(() => syntheticCheckpoint("after_click", fixture,
      { ...env, OPENAPPLY_SUBMISSION_MODE: "enabled" }, exit)).toThrow("unavailable");
    expect(exits).toEqual([86]);
  });
});
