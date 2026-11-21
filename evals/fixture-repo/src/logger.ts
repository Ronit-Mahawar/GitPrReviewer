export const logger = {
  info: (msg: string) => console.log(JSON.stringify({ level: "info", msg, ts: new Date().toISOString() })),
  error: (msg: string, err?: unknown) => console.error(JSON.stringify({ level: "error", msg, err: String(err), ts: new Date().toISOString() })),
};
