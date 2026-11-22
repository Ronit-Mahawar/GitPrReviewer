const ENABLED_FLAGS = new Set((process.env.FEATURE_FLAGS ?? "").split(",").filter(Boolean));

/** True if the named feature flag is on. */
export function isFeatureEnabled(name: string): boolean {
  return ENABLED_FLAGS.has(name);
}
