import { createClient } from "redis";
import { config } from "./config";

export const redis = createClient({ url: config.redisUrl });
