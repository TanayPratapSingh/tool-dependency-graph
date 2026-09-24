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

export function flattenSchema(root: JsonSchema | null | undefined): Slot[] {
  if (!root || typeof root !== "object") return [];

  const slots: Slot[] = [];
  const activeRefs = new Set<string>();

  function visit(
    node: JsonSchema,
    path: string,
    name: string,
    required: boolean,
    repeated: boolean,
    depth: number,
  ): void {
    if (!node || typeof node !== "object" || depth > MAX_DEPTH) return;

    let schema = node;
    const ref = typeof schema.$ref === "string" ? schema.$ref : null;
    if (ref) {
      // Recursive schemas exist in the wild. Visit each $ref once per branch.
      if (activeRefs.has(ref)) return;
      activeRefs.add(ref);
      schema = resolveRef(schema, root);
    }

    // Collapse combinators onto the first branch that carries structure.
    const branches = [schema.anyOf, schema.oneOf, schema.allOf].find(Array.isArray);
    if (branches && branches.length > 0) {
      const structural = branches.find((b) => b && (b.properties || b.items || b.$ref));
      schema = { ...schema, ...(structural ?? branches[0]) };
      if (typeof schema.$ref === "string") schema = resolveRef(schema, root);
    }

    if (schema.properties && typeof schema.properties === "object") {
      const requiredKeys = new Set(Array.isArray(schema.required) ? schema.required : []);
      for (const [key, child] of Object.entries(schema.properties)) {
        visit(
          child as JsonSchema,
          path ? `${path}.${key}` : key,
          key,
          // Requiredness has to compound down the tree. attachment.s3key is
          // required *within* attachment, but attachment itself is optional,
          // so the caller is not obliged to supply s3key at all.
          required && requiredKeys.has(key),
          repeated,
          depth + 1,
        );
      }
      if (ref) activeRefs.delete(ref);
      return; // the container itself is not a slot, only its leaves are
    }

    if (schema.items) {
      const item = Array.isArray(schema.items) ? schema.items[0] : schema.items;
      const itemSchema = item as JsonSchema | undefined;
      const itemHasShape =
        itemSchema &&
        typeof itemSchema === "object" &&
        (itemSchema.properties || itemSchema.$ref || itemSchema.anyOf || itemSchema.oneOf);
      if (itemHasShape) {
        visit(itemSchema, `${path}[]`, name, required, true, depth + 1);
        if (ref) activeRefs.delete(ref);
        return;
      }
      // an array of scalars is itself the meaningful slot, so fall through
    }

    if (path) {
      slots.push({
        path,
        name,
        type: typeOf(schema),
        required,
        description: String(schema.description ?? schema.title ?? ""),
        enumValues: Array.isArray(schema.enum) ? schema.enum.map((v) => String(v)) : null,
        hasDefault: Object.hasOwn(schema, "default"),
        repeated,
      });
    }

    if (ref) activeRefs.delete(ref);
  }

  visit(root, "", "", true, false, 0);
  return slots;
}

/**
 * Path with response envelope segments removed, so that data.items[].id and
 * id compare equal when deciding what a tool actually produces.
 */
export function coreFieldPath(path: string): string {
  return path
    .split(".")
    .map((segment) => segment.replace(/\[\]$/, ""))
    .filter((segment) => !ENVELOPE_KEYS.has(segment))
    .join(".");
}

export function normalizeTool(raw: RawTool, fallbackToolkit: string): NormalizedTool {
  const slug = String(pick(raw, ["slug", "enum", "action_name", "actionName", "name"]) ?? "UNKNOWN");
  const displayName = String(pick(raw, ["displayName", "display_name", "title", "name"]) ?? slug);
  const description = String(pick(raw, ["description", "summary"]) ?? "");

  const toolkitField = pick(raw, ["toolkit", "toolkit_slug", "toolkitSlug", "appName", "app_name", "app"]);
  let toolkit = fallbackToolkit;
  if (typeof toolkitField === "string") {
    toolkit = toolkitField;
  } else if (toolkitField && typeof toolkitField === "object") {
    const obj = toolkitField as Record<string, unknown>;
    toolkit = String(obj.slug ?? obj.name ?? fallbackToolkit);
  }

  const inputSchema = pick(raw, [
    "input_parameters",
    "inputParameters",
    "parameters",
    "input_schema",
    "inputSchema",
  ]) as JsonSchema | undefined;

  const outputSchema = pick(raw, [
    "output_parameters",
    "outputParameters",
    "response",
    "output_schema",
    "outputSchema",
    "response_schema",
  ]) as JsonSchema | undefined;

  const inputs = flattenSchema(inputSchema);
  const outputs = flattenSchema(outputSchema);

  // An envelope of successful/error and nothing else is not a real output shape.
  const informative = outputs.filter(
    (slot) => !["successful", "success", "error", "log_id", "logId", "session_info"].includes(slot.name),
  );

  return {
    slug,
    displayName,
    description,
    toolkit: toolkit.toLowerCase(),
    inputs,
    outputs,
    hasOutputSchema: informative.length > 0,
  };
}
