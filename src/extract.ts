/**
 * Flattens a tool catalog's JSON Schemas into flat slot records.
 *
 * Nothing in this file knows about Gmail or GitHub. It is pure schema walking,
 * kept separate so the domain rules in entities.ts stay readable.
 *
 * Catalogs disagree on casing and on field names, so every field is probed
 * under several spellings rather than assuming one.
 */

export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  enum?: unknown[];
  description?: string;
  title?: string;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
  default?: unknown;
  [key: string]: unknown;
};

export type Slot = {
  /** dotted path from the schema root, with array levels marked by [] */
  path: string;
  /** final path segment, the name a human would use for this field */
  name: string;
  type: string;
  required: boolean;
  description: string;
  enumValues: string[] | null;
  hasDefault: boolean;
  /** true when the slot sits under an array, so the tool yields many of them */
  repeated: boolean;
};

export type RawTool = Record<string, unknown>;

export type NormalizedTool = {
  slug: string;
  displayName: string;
  description: string;
  toolkit: string;
  inputs: Slot[];
  outputs: Slot[];
  /** false when the catalog gave us no usable output shape for this tool */
  hasOutputSchema: boolean;
};

const MAX_DEPTH = 7;

/** Common response envelope keys, stripped when matching field names. */
const ENVELOPE_KEYS = new Set(["data", "response_data", "responseData", "result", "items", "records"]);

function pick(source: RawTool, keys: string[]): unknown {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function typeOf(schema: JsonSchema): string {
  if (Array.isArray(schema.type)) {
    const named = schema.type.filter((t) => t !== "null");
    return named.length ? named.join("|") : "unknown";
  }
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.enum)) return "enum";
  if (schema.properties) return "object";
  if (schema.items) return "array";
  return "unknown";
}

/** Resolves a local $ref like "#/$defs/Thread" against the document root. */
function resolveRef(schema: JsonSchema, root: JsonSchema): JsonSchema {
  const ref = schema.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) return schema;
  let cursor: unknown = root;
  for (const segment of ref.slice(2).split("/")) {
    if (cursor && typeof cursor === "object" && segment in (cursor as object)) {
      cursor = (cursor as Record<string, unknown>)[segment];
    } else {
      return schema;
    }
  }
  return cursor && typeof cursor === "object" ? (cursor as JsonSchema) : schema;
}

