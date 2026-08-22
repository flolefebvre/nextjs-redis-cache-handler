import { createServer } from "node:net";
import {
  GenericContainer,
  Wait,
  getContainerRuntimeClient,
  type StartedTestContainer,
} from "testcontainers";

/**
 * The server the integration project runs against unless `CACHE_TEST_IMAGE` says
 * otherwise. The only place an image is named.
 */
export const DEFAULT_TEST_IMAGE = "valkey/valkey:8";

const REDIS_PORT = 6379;

/**
 * The image to start: `CACHE_TEST_IMAGE` when it holds something, the default
 * otherwise. An empty or blank variable counts as unset, so an unfilled CI matrix
 * input falls back to the default instead of failing on an empty image name.
 */
export function testImage(env: NodeJS.ProcessEnv = process.env): string {
  return env.CACHE_TEST_IMAGE?.trim() || DEFAULT_TEST_IMAGE;
}

/**
 * The server to use instead of a container: `CACHE_TEST_REDIS_URL` when it holds
 * something, `undefined` otherwise. When it is set no container is started, which is
 * how a run against an already-running server, or a Docker-less machine, works.
 */
export function providedRedisUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.CACHE_TEST_REDIS_URL?.trim() || undefined;
}

/** A running server, and the way to stop it. */
export interface RunningRedis {
  url: string;
  stop(): Promise<void>;
}

/**
 * Start one throwaway server for the run. Testcontainers publishes the port on a
 * random host port, so concurrent runs never collide; Ryuk removes the container even
 * when the run is killed before teardown.
 */
export async function startRedisContainer(image: string): Promise<RunningRedis> {
  const container: StartedTestContainer = await new GenericContainer(image)
    .withExposedPorts(REDIS_PORT)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  return {
    url: `redis://${container.getHost()}:${String(container.getMappedPort(REDIS_PORT))}`,
    stop: async () => {
      await container.stop();
    },
  };
}

/**
 * A server one test file owns, and the three states an outage puts it through: stalled
 * (frozen, the socket stays open and nothing answers), down (the port refuses
 * connections), and back. It is never the shared server of the run: a test that stalls
 * the server every other worker talks to would stall the whole suite.
 */
export interface OutageRedis {
  /** Where it answers, on a host port of its own so that the URL survives a stop. */
  url: string;
  /** Freeze the server: connections stay open, commands never get a reply. */
  pause(): Promise<void>;
  /** Unfreeze it: the commands that were in flight get their reply. */
  unpause(): Promise<void>;
  /** Take it down: the port refuses connections, and what it held is kept. */
  stop(): Promise<void>;
  /** Bring the same server back on the same port, with everything it held. */
  start(): Promise<void>;
  /** Remove it, whatever state it is in. */
  remove(): Promise<void>;
}

/**
 * Start a server for one test file to break. The host port is chosen here rather than
 * left to Docker: a stopped container comes back on a new random mapping, and a handler
 * configured with a URL cannot follow it.
 *
 * `pause` goes through the container runtime Testcontainers itself talks to, because a
 * started container exposes no pause of its own. It is the only way to reach a stalled
 * server — a socket that is open with nothing answering — which is the only state that
 * makes an operation hit its deadline rather than fail outright.
 */
export async function startOutageRedis(image: string): Promise<OutageRedis> {
  const port = await freeHostPort();
  const container = await new GenericContainer(image)
    .withExposedPorts({ container: REDIS_PORT, host: port })
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  const runtime = await getContainerRuntimeClient();
  const runningContainer = runtime.container.getById(container.getId());

  return {
    url: `redis://127.0.0.1:${String(port)}`,
    pause: async () => {
      await runningContainer.pause();
    },
    unpause: async () => {
      await runningContainer.unpause();
    },
    stop: async () => {
      await container.stop({ remove: false });
    },
    start: async () => {
      await container.restart();
    },
    remove: async () => {
      await container.stop();
    },
  };
}

async function freeHostPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));

  return port;
}
