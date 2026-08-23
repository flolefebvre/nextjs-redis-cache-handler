import { expect } from "vitest";

import type { InstanceName, Instances } from "./instances.js";

/** The Fixture's dynamic route: a page whose cached scopes are read on every request. */
export const POST = "/posts/1";

/** The Fixture's Prerendered route, served from each Instance's own ISR cache. */
export const LIST = "/";

/** The Fixture's partially prerendered route: a cached shell, and a dynamic hole. */
export const PPR = "/ppr";

const POST_MARKERS = ["comments", "post-body", "remote-note"];

/**
 * What every cached scope of the post page rendered at, on one Instance. Every marker has
 * to be there: a page that rendered none would make every comparison below a comparison of
 * two absent values, which passes without observing anything.
 */
export async function postMarkers(
  instances: Instances,
  instance: InstanceName,
  headers?: Record<string, string>,
): Promise<Record<string, string>> {
  const { markers } = await instances.get(instance, POST, headers);

  return everyMarker(markers);
}

/** The same markers, once the named scope has stopped rendering the instant it did before. */
export async function postMarkersOnceChanged(
  instances: Instances,
  instance: InstanceName,
  marker: string,
  before: string | undefined,
): Promise<Record<string, string>> {
  return everyMarker(await instances.markersOnceChanged(instance, POST, marker, before));
}

function everyMarker(markers: Record<string, string>): Record<string, string> {
  expect(Object.keys(markers).sort()).toEqual(POST_MARKERS);

  return markers;
}
