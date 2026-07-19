/** Tiny structured logger — timestamps + component tags, no dependencies. */

export function makeLog(component: string) {
  const tag = `[${component}]`;
  return {
    info: (...args: unknown[]) => console.log(new Date().toISOString(), tag, ...args),
    warn: (...args: unknown[]) => console.warn(new Date().toISOString(), tag, "WARN", ...args),
    error: (...args: unknown[]) => console.error(new Date().toISOString(), tag, "ERROR", ...args),
  };
}
