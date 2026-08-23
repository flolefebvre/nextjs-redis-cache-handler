import { createServer } from "node:net";
import {
  GenericContainer,
  Wait,
  getContainerRuntimeClient,
  type ContainerRuntimeClient,
  type StartedTestContainer,
} from "testcontainers";

/**
 * The server the integration project runs against unless `CACHE_TEST_IMAGE` says
 * otherwise. The only place an image is named.
 */
export const DEFAULT_TEST_IMAGE = "valkey/valkey:8";

/** The lowest Redis a supported deployment may run on, and what the matrix's `redis:6.2` cell proves. */
export const REDIS_VERSION_FLOOR = "6.2";

/** The lowest Valkey a supported deployment may run on, and what the matrix's `valkey/valkey:7.2` cell proves. */
export const VALKEY_VERSION_FLOOR = "7.2";

/** The two server families the handler supports, each with a floor of its own. */
export type ServerFamily = "redis" | "valkey";

/** What a server says it is: its family, the version that family reports, and the floor it owes. */
export interface ServerVersion {
  family: ServerFamily;
  version: string;
  floor: string;
}

/**
 * Read a server's family and version out of an `INFO server` reply.
 *
 * A Valkey server is recognised by `valkey_version`, and only that field carries its real
 * version: its `redis_version` is a frozen compatibility string — `7.2.4` on Valkey 7.2 and
 * on Valkey 9 alike — so `redis_version` decides nothing here and must decide nothing
 * anywhere else in the harness. It is read for a server that reports no `valkey_version` at
 * all, which is the Redis family.
 */
export function serverVersion(info: string): ServerVersion {
  const valkey = versionField(info, "valkey_version");
  if (valkey !== undefined) {
    return { family: "valkey", version: valkey, floor: VALKEY_VERSION_FLOOR };
  }

  const redis = versionField(info, "redis_version");
  if (redis === undefined) {
    throw new Error("The INFO server reply carries neither a valkey_version nor a redis_version");
  }

  return { family: "redis", version: redis, floor: REDIS_VERSION_FLOOR };
}

function versionField(info: string, field: string): string | undefined {
  return new RegExp(`^${field}:(.+)$`, "m").exec(info)?.[1]?.trim();
}

/**
 * Whether a version is at or above a floor, compared component by component and numerically:
 * a lexical comparison would put `10.0.0` below `7.2` and let a mis-tagged image pass.
 */
export function meetsFloor(version: string, floor: string): boolean {
  const components = (value: string): number[] => value.split(".").map(Number);
  const actual = components(version);

  for (const [index, required] of components(floor).entries()) {
    const component = actual[index] ?? 0;
    if (component !== required) return component > required;
  }

  return true;
}

const REDIS_PORT = 6379;

type RunningContainer = ReturnType<ContainerRuntimeClient["container"]["getById"]>;

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
  /** Where it answers, on a host port of its own that every state of it keeps. */
  url: string;
  /** Freeze the server: connections stay open, commands never get a reply. */
  pause(): Promise<void>;
  /** Unfreeze it: the commands that were in flight get their reply. Does nothing if it is running. */
  unpause(): Promise<void>;
  /** Take it down: the port refuses connections, and nothing it held survives. */
  stop(): Promise<void>;
  /** Put a server back on the same port, empty. Does nothing if one is already up. */
  start(): Promise<void>;
  /** Leave nothing behind, whatever state it is in. */
  remove(): Promise<void>;
}

/**
 * Start a server for one test file to break. The host port is chosen here rather than
 * left to Docker, because a server that goes down and comes back has to answer at the
 * same URL: a handler configured with one cannot follow a new random mapping.
 *
 * Down means removed, not stopped. A stopped container keeps the runtime's port
 * forwarding bound on some hosts, where it accepts a connection and then answers
 * nothing — which is stalled, not down, and hides the very difference these tests are
 * about. A removed container releases the port, so a connection is refused as promptly
 * on a developer's machine as in CI. Nothing a removed server held comes back with the
 * next one: a test writes what it needs after `start`.
 *
 * `pause` goes through the container runtime Testcontainers itself talks to, because a
 * started container exposes no pause of its own. It is the only way to reach a stalled
 * server — a socket that is open with nothing answering — which is the only state that
 * makes an operation hit its deadline rather than fail outright.
 *
 * Coming back is idempotent, on purpose: a test whose assertion fails before it put the
 * server back would otherwise hand the next one a server that is down, and a cleanup that
 * puts it back unconditionally would fail on a server that is already up.
 */
export async function startOutageRedis(image: string): Promise<OutageRedis> {
  const port = await freeHostPort();
  const definition = (): GenericContainer =>
    new GenericContainer(image)
      .withExposedPorts({ container: REDIS_PORT, host: port })
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/));
  const runtime = await getContainerRuntimeClient();
  let container: StartedTestContainer | undefined = await definition().start();

  const running = (): RunningContainer => {
    if (container === undefined) throw new Error("the outage server is down");

    return runtime.container.getById(container.getId());
  };

  const down = async (): Promise<void> => {
    const stopping = container;
    container = undefined;
    await stopping?.stop({ remove: true });
  };

  return {
    url: `redis://127.0.0.1:${String(port)}`,
    pause: async () => {
      await running().pause();
    },
    unpause: async () => {
      const current = running();
      const { State } = await runtime.container.inspect(current);
      if (State.Paused) await current.unpause();
    },
    stop: down,
    start: async () => {
      container ??= await definition().start();
    },
    remove: down,
  };
}

/** A multi-process deployment one test file owns, and where its servers answer. */
export interface RunningTopology {
  /** The data nodes, in the order the topology's script started them. */
  nodeUrls: string[];
  /** Leave nothing behind. */
  stop(): Promise<void>;
}

/** A Sentinel deployment: its data nodes, and the Sentinel that watches them. */
export interface RunningSentinel extends RunningTopology {
  /** Where the Sentinel answers, which is what a Sentinel client is pointed at. */
  sentinelUrl: string;
}

const CLUSTER_READY = "CLUSTER READY";

const SENTINEL_READY = "SENTINEL READY";

/** The name the Sentinel deployment watches its master under. */
export const SENTINEL_MASTER_NAME = "mymaster";

const CLUSTER_ANNOUNCE_IP = "127.0.0.1";

const CLUSTER_MASTERS = 3;

const CLUSTER_REPLICAS_PER_MASTER = 1;

const CLUSTER_NODES = CLUSTER_MASTERS * (1 + CLUSTER_REPLICAS_PER_MASTER);

const BUS_PORT_OFFSET = 10_000;

const DOWN_AFTER_MS = 1_000;

const FAILOVER_TIMEOUT_MS = 5_000;

/**
 * The options every server of a topology is started with: nothing is persisted, because a
 * topology lives for one test file and comes back empty or not at all.
 */
const VOLATILE = "--save '' --appendonly no --daemonize no";

/**
 * Start one container running a whole topology, on host ports it also listens on inside.
 *
 * The ports are the same on both sides on purpose. A Sentinel hands out the address of the
 * master it watches and a Cluster node hands out the address of the node owning a slot, so
 * a client only works when the addresses those servers announce are the ones the host can
 * dial: a random published port would send it to a port nothing is on. The addresses are
 * `127.0.0.1` for the same reason — loopback inside the container is loopback on the host,
 * where the tests run, and a container's own address is not routable from there.
 *
 * The image is the one the whole suite runs against, and the servers are started by the
 * `redis-server` and `redis-cli` names: the Valkey images ship those as symlinks, the
 * Redis images ship nothing else, so one command serves every image of the matrix.
 */
async function startTopology(
  image: string,
  ports: number[],
  script: string,
  ready: string,
): Promise<StartedTestContainer> {
  return new GenericContainer(image)
    .withExposedPorts(...ports.map((port) => ({ container: port, host: port })))
    .withEntrypoint(["/bin/sh", "-c"])
    .withCommand([script])
    .withWaitStrategy(Wait.forLogMessage(ready))
    .start();
}

/**
 * The wait for every one of these servers to be answering, before a script asks anything
 * of them. A server started in the background is not listening yet, and how long it takes
 * is not something a `sleep` can know: under CI load a `--cluster create` sent too early
 * fails outright, and what a test then sees is the readiness wait timing out.
 */
function answering(ports: number[]): string {
  return ports
    .map((port) => `until redis-cli -p ${String(port)} ping | grep -q PONG; do sleep 0.2; done`)
    .join("\n");
}

/**
 * The wait for a Cluster whose replicas are up and reachable, asked of the nodes themselves
 * rather than of the create that asked for them.
 *
 * `cluster_state:ok` says every slot is covered, which the masters answer on their own: it
 * holds before a replica has synced and long before any node publishes one, and a client
 * built with `useReplicas` at that moment is handed a topology with no replica to route to
 * — under which a cell asserting the handler's reads stay on the master is green having
 * proven nothing.
 *
 * So two more things are waited on. Each master is asked whether it counts its replica and
 * each replica whether its link to the master is up, out of `INFO replication`: that is the
 * replica holding the data. Then every node is asked for `CLUSTER SLOTS` until it lists all
 * six announced addresses: that is the replica being routable, and it is the view a client
 * builds its own from. The second is the later of the two by seconds — a master publishes a
 * replica there only once the cluster bus has been round it — and it is the one a replica
 * read depends on, so neither stands for the other.
 *
 * Both are read with commands the supported floor has: `CLUSTER SHARDS` states all of it in
 * one reply but is Redis 7.0 and up, while the floor is 6.2, whose `CLUSTER SLOTS` reply
 * differs only by the trailing metadata map — not by the addresses counted here.
 */
function replicated(ports: number[]): string {
  const infos = ports.map((port) => `redis-cli -p ${String(port)} info replication`).join("; ");
  const linked = `^(connected_slaves:${String(CLUSTER_REPLICAS_PER_MASTER)}|master_link_status:up)`;
  const routable = ports.map(
    (port) =>
      `until [ "$(redis-cli -p ${String(port)} cluster slots | grep -c '^${CLUSTER_ANNOUNCE_IP}$')"` +
      ` = ${String(CLUSTER_NODES)} ]; do sleep 0.2; done`,
  );

  return [
    `until [ "$({ ${infos}; } | grep -Ec '${linked}')" = ${String(CLUSTER_NODES)} ]; do sleep 0.2; done`,
    ...routable,
  ].join("\n");
}

/**
 * Start a Cluster for one test file: three masters with one replica each, every slot
 * covered. The replicas are three more `redis-server` processes in the same container and
 * `--cluster-replicas` on the create, not three more containers, and `nodeUrls` lists every
 * one of the six — a test reads the `MONITOR` stream of a replica as it does of a master.
 *
 * Each node announces `127.0.0.1` and the very port it listens on, so the `MOVED` a node
 * answers with sends the client to an address the host can dial. The bus ports are the
 * announced ports plus the usual offset and are never published: the nodes gossip over
 * loopback inside the container, and a client never dials one.
 *
 * It is ready in two stages, because a replica being up and a replica being routable are
 * not the same instant and here they are some eight seconds apart. The link comes up first
 * — `INFO replication` reports the master counting its replica and the replica following it
 * — and only later does a master publish that replica in `CLUSTER SLOTS`, which is the view
 * a client builds its routing from and the only one that decides where a replica read goes.
 * So the second stage waits every node's own `CLUSTER SLOTS` out, on every node because a
 * client may bootstrap its topology from any of the root nodes it was given. It is the same
 * kind of rule as the Sentinel deployment's `master-link-status` wait and for the same
 * reason: a deployment handed over before the view it is used through agrees is one whose
 * cells assert against a topology that is not there yet.
 */
export async function startClusterRedis(image: string): Promise<RunningTopology> {
  const ports = await Promise.all(Array.from({ length: CLUSTER_NODES }, () => freeHostPort()));
  const addresses = ports.map((port) => `${CLUSTER_ANNOUNCE_IP}:${String(port)}`);
  const nodes = ports
    .map(
      (port) =>
        `redis-server --port ${String(port)} ${VOLATILE} --cluster-enabled yes` +
        ` --cluster-config-file /tmp/node-${String(port)}.conf` +
        ` --cluster-announce-ip ${CLUSTER_ANNOUNCE_IP}` +
        ` --cluster-announce-port ${String(port)}` +
        ` --cluster-announce-bus-port ${String(port + BUS_PORT_OFFSET)} &`,
    )
    .join("\n");
  const first = String(ports[0]);
  const container = await startTopology(
    image,
    ports,
    `${nodes}
${answering(ports)}
redis-cli --cluster create ${addresses.join(" ")} --cluster-replicas ${String(CLUSTER_REPLICAS_PER_MASTER)} --cluster-yes
until redis-cli -p ${first} cluster info | grep -q cluster_state:ok; do sleep 1; done
${replicated(ports)}
echo ${CLUSTER_READY}
wait`,
    CLUSTER_READY,
  );

  return {
    nodeUrls: ports.map((port) => `redis://${CLUSTER_ANNOUNCE_IP}:${String(port)}`),
    stop: async () => {
      await container.stop({ remove: true });
    },
  };
}

/**
 * Start a Sentinel deployment for one test file: one master, one replica, one Sentinel
 * with a quorum of one, so that a single `SENTINEL FAILOVER` promotes the replica.
 *
 * Everything talks over loopback, which is what makes the master address the Sentinel
 * hands out — and the replica address it learns from the master's `INFO` — dialable from
 * the host. The failure detection is turned down to a second so a test does not wait a
 * default minute for a rebuild to be noticed.
 *
 * It is ready only once the Sentinel reports the replica's link to the master as `ok`,
 * which is the same rule `promotableReplica` waits on before a failover and for the same
 * reason: a failover asked for while that view says `err` is abandoned silently.
 */
export async function startSentinelRedis(image: string): Promise<RunningSentinel> {
  const [master, replica, sentinel] = await Promise.all([
    freeHostPort(),
    freeHostPort(),
    freeHostPort(),
  ]);
  const ports = [master, replica, sentinel];
  const masterPort = String(master);
  const replicaPort = String(replica);
  const sentinelPort = String(sentinel);
  const container = await startTopology(
    image,
    ports,
    `redis-server --port ${masterPort} ${VOLATILE} &
redis-server --port ${replicaPort} ${VOLATILE} --replicaof 127.0.0.1 ${masterPort} &
${answering([master, replica])}
{
  echo "port ${sentinelPort}"
  echo "sentinel monitor ${SENTINEL_MASTER_NAME} 127.0.0.1 ${masterPort} 1"
  echo "sentinel down-after-milliseconds ${SENTINEL_MASTER_NAME} ${String(DOWN_AFTER_MS)}"
  echo "sentinel failover-timeout ${SENTINEL_MASTER_NAME} ${String(FAILOVER_TIMEOUT_MS)}"
} > /tmp/sentinel.conf
redis-server /tmp/sentinel.conf --sentinel &
until redis-cli -p ${sentinelPort} sentinel get-master-addr-by-name ${SENTINEL_MASTER_NAME} | grep -q 127.0.0.1; do sleep 0.2; done
until redis-cli -p ${sentinelPort} sentinel replicas ${SENTINEL_MASTER_NAME} | grep -A 1 master-link-status | grep -qx ok; do sleep 0.2; done
echo ${SENTINEL_READY}
wait`,
    SENTINEL_READY,
  );

  return {
    nodeUrls: [masterPort, replicaPort].map((port) => `redis://127.0.0.1:${port}`),
    sentinelUrl: `redis://127.0.0.1:${sentinelPort}`,
    stop: async () => {
      await container.stop({ remove: true });
    },
  };
}

/**
 * A host port nothing is listening on, taken by binding one and letting it go: what a
 * server that has to answer at a fixed URL is started on, and what the e2e harness gives
 * each Instance so two runs on one machine never collide.
 */
export async function freeHostPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));

  return port;
}
