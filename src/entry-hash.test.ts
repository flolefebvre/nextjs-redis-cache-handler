import { expect, test } from "vitest";

import {
  WRITE_TIME_FIELD,
  decodeEntryHash,
  encodeEntryFields,
  parseEntryReply,
  type BufferedEntry,
} from "./entry-hash.js";

const entry: BufferedEntry = {
  value: Uint8Array.from([0x00, 0xff, 0xfe, 0x80, 0x01, 0xc3, 0x28]),
  tags: ["posts", "post:1"],
  stale: 300,
  timestamp: 1787325433671,
  expire: 900,
  revalidate: 60,
};

function hashOf(written: BufferedEntry, writeTime: number): Map<string, Buffer> {
  const hash = new Map<string, Buffer>([[WRITE_TIME_FIELD, Buffer.from(String(writeTime))]]);
  const fields = encodeEntryFields(written);

  for (let index = 0; index + 1 < fields.length; index += 2) {
    const name = fields[index];
    const value = fields[index + 1];
    if (typeof name !== "string" || value === undefined) continue;
    hash.set(name, Buffer.isBuffer(value) ? value : Buffer.from(value));
  }

  return hash;
}

/** The same hash with one field replaced, as a store holding an unreadable one would. */
function withField(hash: Map<string, Buffer>, name: string, value: Buffer): Map<string, Buffer> {
  return new Map(hash).set(name, value);
}

function decoded(hash: Map<string, Buffer>): unknown {
  const stored = decodeEntryHash(hash);

  return stored && { ...stored, value: Uint8Array.from(stored.value) };
}

test("an Entry survives the round trip through the hash fields", () => {
  expect(decoded(hashOf(entry, 1787325433600))).toEqual({ ...entry, writeTime: 1787325433600 });
});

test("the never sentinel, Infinity and negative timings survive the round trip", () => {
  const timings = { ...entry, stale: 4294967294, expire: Infinity, revalidate: -1 };

  const stored = decodeEntryHash(hashOf(timings, 1));

  expect(stored).toMatchObject({ stale: 4294967294, expire: Infinity, revalidate: -1 });
});

test("an Entry with no tags and an empty value survives the round trip", () => {
  const empty = { ...entry, tags: [], value: new Uint8Array() };

  expect(decoded(hashOf(empty, 2))).toEqual({ ...empty, writeTime: 2 });
});

test("a hash missing any field is not an Entry", () => {
  const complete = hashOf(entry, 3);

  expect(decodeEntryHash(new Map())).toBeUndefined();
  for (const field of complete.keys()) {
    const incomplete = new Map(complete);
    incomplete.delete(field);

    expect(decodeEntryHash(incomplete), `without ${field}`).toBeUndefined();
  }
});

test("a hash whose timings or tags are unreadable is not an Entry", () => {
  const complete = hashOf(entry, 3);

  expect(decodeEntryHash(withField(complete, "expire", Buffer.from("later")))).toBeUndefined();
  expect(decodeEntryHash(withField(complete, "tags", Buffer.from("posts")))).toBeUndefined();
  expect(decodeEntryHash(withField(complete, "tags", Buffer.from('{"a":1}')))).toBeUndefined();
  expect(decodeEntryHash(withField(complete, WRITE_TIME_FIELD, Buffer.from("")))).toBeUndefined();
});

test("an Entry survives the round trip through the reply of the read script", () => {
  const written = encodeEntryFields(entry);
  const reply = [WRITE_TIME_FIELD, "1787325433600", ...written].map((field) =>
    Buffer.isBuffer(field) ? field : Buffer.from(field),
  );

  const stored = parseEntryReply(reply);

  expect(stored && { ...stored, value: Uint8Array.from(stored.value) }).toEqual({
    ...entry,
    writeTime: 1787325433600,
  });
});

test("the reply for a key the store holds nothing for is not an Entry", () => {
  expect(parseEntryReply([])).toBeUndefined();
});

test("a reply that is not a hash at all is a failure, not a miss", () => {
  expect(() => parseEntryReply("entry")).toThrow();
});
