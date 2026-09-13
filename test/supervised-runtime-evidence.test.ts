import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeObservationSchema, revalidateRuntimeHandoff, validateCurrentRuntime } from "../src/domain/sprint-delivery/v1/runtime-evidence.js";
import { createSupervisedRuntimeObserver, installSupervisedDeadline, readSupervisedTaskMetadata } from "../src/runtime/v1/supervised-runtime-evidence.js";
import { runtimeEvidence } from "./fixtures/runtime-evidence.js";

const prior = runtimeEvidence();
const uri = "http://169.254.170.2/v4/fixture-container";
const metadata = () => ({ Cluster: prior.constraints.clusterArn, TaskARN: prior.taskArn, Family: "ai-delivery-orchestrator-pilot-supervised-dispatch", Revision: "21", DesiredStatus: "RUNNING", KnownStatus: "RUNNING", LaunchType: "FARGATE",
  Containers: [{ Name: "supervised-dispatch", Image: `123456789012.dkr.ecr.us-east-1.amazonaws.com/ai-delivery-orchestrator-worker@${prior.constraints.imageDigest}`, ImageID: prior.constraints.imageDigest, KnownStatus: "RUNNING" }],
});
afterEach(() => vi.useRealTimers());

describe("supervised runtime evidence", () => {
  it("observes the exact pinned runtime and strips unknown AWS metadata", async () => {
    const now = () => new Date(prior.observedAt);
    const deadline = installSupervisedDeadline(now);
    try {
      const observer = createSupervisedRuntimeObserver({ constraints: prior.constraints, mode: "preflight", executionEnabled: false, metadataUri: uri, deadline, now,
        readMetadata: () => Promise.resolve({ ...metadata(), secret: "private-sentinel" }),
      });
      expect(await observer.observe()).toEqual(prior);
      deadline.close();
      await expect(observer.observe()).rejects.toThrow("runtime observation unavailable");
    } finally { deadline.close(); }
  });
  it.each(["image", "family", "revision", "account", "cluster", "duplicate", "stopped", "missing", "provider"])("rejects %s metadata without source leakage", async reason => {
    const now = () => new Date(prior.observedAt);
    const deadline = installSupervisedDeadline(now);
    const value = metadata();
    if (reason === "image") value.Containers[0]!.ImageID = `sha256:${"e".repeat(64)}`;
    if (reason === "family") value.Family = "other-family";
    if (reason === "revision") value.Revision = "22";
    if (reason === "account") value.TaskARN = value.TaskARN.replace("123456789012", "111111111111");
    if (reason === "cluster") value.Cluster = "other-cluster";
    if (reason === "duplicate") value.Containers.push(value.Containers[0]!);
    if (reason === "stopped") value.KnownStatus = "STOPPED";
    try {
      const observer = createSupervisedRuntimeObserver({ constraints: prior.constraints, mode: "preflight", executionEnabled: false, metadataUri: uri, deadline, now,
        readMetadata: () => reason === "provider" ? Promise.reject(new Error("private-sentinel")) : Promise.resolve(reason === "missing" ? {} : value),
      });
      const error = await observer.observe().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toBe("Error: runtime observation unavailable or invalid");
    } finally { deadline.close(); }
  });
  it("installs a real bounded timer and invalidates observations after expiry or close", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(prior.startedAt));
    const terminate = vi.fn();
    const guard = installSupervisedDeadline(() => new Date(), terminate);
    expect(guard.observe().deadlineInstalled).toBe(true);
    vi.advanceTimersByTime(179_999);
    expect(terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(() => guard.observe()).toThrow();
    guard.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects clock rollback, future/stale observations and claims about unobserved controls", () => {
    const now = new Date(prior.observedAt);
    for (const patch of [{ version: "unknown" }, { deadlineInstalled: false }, { executionEnabled: true }, { otherRuntimeControls: "disabled" }, { extra: "private-sentinel" }, { deadlineAt: prior.startedAt }]) {
      expect(RuntimeObservationSchema.safeParse({ ...prior, ...patch }).success).toBe(false);
    }
    expect(() => validateCurrentRuntime(prior, prior.constraints.repository, "preflight", false, new Date(now.getTime() - 1))).toThrow();
    expect(() => validateCurrentRuntime(prior, prior.constraints.repository, "preflight", false, new Date(now.getTime() + 5_001))).toThrow();
    expect(() => validateCurrentRuntime(prior, "other/repository", "preflight", false, now)).toThrow();
  });
  it("permits a new task only under identical reviewed constraints, even after the prior task deadline", () => {
    const current = runtimeEvidence("2026-09-12T16:04:00.000Z", true);
    const now = new Date(current.observedAt);
    expect(revalidateRuntimeHandoff(prior, current, now)).toEqual(prior);
    for (const constraints of [{ ...current.constraints, imageDigest: `sha256:${"f".repeat(64)}` }, { ...current.constraints, configurationFingerprint: "e".repeat(64) }, { ...current.constraints, taskDefinitionArn: current.constraints.taskDefinitionArn.replace(":21", ":22") }, { ...current.constraints, maximumDurationMilliseconds: 360_000 }]) {
      expect(() => revalidateRuntimeHandoff(prior, { ...current, constraints } as never, now)).toThrow();
    }
    expect(() => revalidateRuntimeHandoff(prior, current, new Date("2026-09-12T16:05:00Z"))).toThrow();
    expect(() => revalidateRuntimeHandoff(prior, { ...current, executionEnabled: false }, now)).toThrow();
  });
});

describe("fixed task-local HTTP boundary", () => {
  it.each(["https://169.254.170.2/v4/a", "http://169.254.169.254/v4/a", "http://localhost/v4/a", "http://user@169.254.170.2/v4/a", `${uri}/../credentials`, `${uri}?token=private-sentinel`, `${uri}#x`, "http://2852039170/v4/a", "http://169.254.170.2:80/v4/a", `${uri}/task`, "http://169.254.170.2/v4/%61"])("rejects an outside URL before any request (%s)", async value => {
    const send = vi.fn();
    await expect(readSupervisedTaskMetadata(value, send as unknown as typeof request)).rejects.toThrow("task metadata unavailable");
    expect(send).not.toHaveBeenCalled();
  });
  it.each(["valid", "redirect", "oversized", "malformed", "aborted"])("bounds the HTTP response (%s)", async mode => {
    const send = vi.fn((url: string, options: { agent: boolean; signal: AbortSignal }, callback: (response: unknown) => void) => {
      expect(url).toBe(`${uri}/task`);
      expect(options.agent).toBe(false);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      const req = Object.assign(new EventEmitter(), { end: () => {}, destroy: () => {} });
      queueMicrotask(() => {
        const stream = Object.assign(new PassThrough(), { statusCode: mode === "redirect" ? 302 : 200 });
        callback(stream);
        if (mode === "aborted") { stream.emit("aborted"); stream.destroy(); }
        else stream.end(mode === "oversized" ? "x".repeat(65_537) : mode === "malformed" ? "private-sentinel" : JSON.stringify({ okay: true }));
      });
      return req;
    });
    const result = readSupervisedTaskMetadata(uri, send as unknown as typeof request);
    if (mode === "valid") await expect(result).resolves.toEqual({ okay: true });
    else await expect(result).rejects.toThrow("task metadata unavailable");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("aborts a stalled request within the fixed five-second budget", async () => {
    const send = vi.fn((_url: string, options: { signal: AbortSignal }) => {
      const req = Object.assign(new EventEmitter(), { end: () => {}, destroy: () => {} });
      options.signal.addEventListener("abort", () => req.emit("error", new Error("private-sentinel")), { once: true });
      return req;
    });
    await expect(readSupervisedTaskMetadata(uri, send as unknown as typeof request)).rejects.toThrow("task metadata unavailable");
    expect(send).toHaveBeenCalledTimes(1);
  }, 10_000);
});
