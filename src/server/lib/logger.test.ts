import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentLogLevel, logger } from "./logger";

describe("logger", () => {
  const original = process.env.LOG_LEVEL;
  let log: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (original === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = original;
  });

  it("defaults to info when LOG_LEVEL is unset or invalid", () => {
    delete process.env.LOG_LEVEL;
    expect(currentLogLevel()).toBe("info");
    process.env.LOG_LEVEL = "verbose";
    expect(currentLogLevel()).toBe("info");
  });

  it("drops debug output unless LOG_LEVEL=debug", () => {
    delete process.env.LOG_LEVEL;
    logger.debug("raw output");
    expect(log).not.toHaveBeenCalled();

    process.env.LOG_LEVEL = "DEBUG";
    logger.debug("raw output");
    expect(log).toHaveBeenCalledWith("[debug] raw output");
  });

  it("drops levels below the configured one", () => {
    process.env.LOG_LEVEL = "warn";
    logger.info("hidden");
    logger.warn("shown");
    logger.error("shown too");
    expect(log).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[warn] shown");
    expect(error).toHaveBeenCalledWith("[error] shown too");
  });

  it("appends fields as JSON", () => {
    delete process.env.LOG_LEVEL;
    logger.info("review saved", { reviewId: "r1", comments: 3 });
    expect(log).toHaveBeenCalledWith('[info] review saved {"reviewId":"r1","comments":3}');
  });
});
