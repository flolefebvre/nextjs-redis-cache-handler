import { handlerPath } from "@flefebvre/nextjs-redis-cache-handler";

export default {
  cacheComponents: true,
  cacheHandlers: {
    default: handlerPath,
  },
};
