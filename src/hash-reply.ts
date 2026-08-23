const BAD_REPLY = "unreadable hash reply";

/**
 * The fields of one hash, from the flat field/value array a Lua `HGETALL` reply is: Redis
 * converts a script's reply to RESP2 shapes whatever RESP version the connection speaks,
 * unless the script asks otherwise, which none of this library's do. It is what lets one
 * pairing serve every hash this handler reads, on a client of any kind and any tuning.
 *
 * A field name is text whatever type mapping the script declared — a mapping that brings
 * blob strings back as bytes brings the names back as bytes too, and every name this
 * library reads is ASCII either way — so names are decoded here and values are handed on
 * exactly as they came: an Entry's value is bytes no UTF-8 decoder would give back.
 *
 * The fields carry no prototype of their own: a hash field is named by whoever wrote it —
 * a tag is the app developer's string — and `__proto__` assigned on an ordinary object is
 * swallowed by the accessor it inherits rather than kept as a field, which would drop a
 * tag's invalidation without a trace.
 *
 * A reply that is not a flat pair list throws. It is not something a healthy server running
 * one of these scripts can answer, so it is a failure — a proxy rewriting replies, a type
 * mapping regression — and reading it as an absent hash would bury that behind a miss, which
 * a caller cannot tell from an empty store. An empty reply is a pair list like any other,
 * and the one legitimate "nothing" here: the key holds no hash.
 */
export function hashFieldsOf(reply: unknown): Record<string, unknown> {
  if (!Array.isArray(reply) || reply.length % 2 !== 0) throw new Error(BAD_REPLY);

  const fields = Object.create(null) as Record<string, unknown>;
  for (let index = 0; index < reply.length; index += 2) {
    fields[nameOf(reply[index])] = reply[index + 1];
  }

  return fields;
}

function nameOf(field: unknown): string {
  return Buffer.isBuffer(field) ? field.toString() : String(field);
}
