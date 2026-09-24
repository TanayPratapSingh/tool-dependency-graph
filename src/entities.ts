/**
 * Canonical entity registry.
 *
 * The naive version of this task matches input parameter names against output
 * field names and calls that a dependency. That fails badly: "id", "name",
 * "query" and "type" appear on dozens of unrelated tools, so a bare name match
 * wires Gmail to GitHub and produces a hairball with no meaning.
 *
 * Instead every handle is resolved to a namespaced entity, and resolution is
 * scoped by the service that owns the tool. A bare "id" on a GMAIL_ tool can
 * only resolve inside the gmail namespace. Anything still ambiguous is left
 * unmapped and reported, rather than guessed.
 */

export type EntityId = string;

export type Entity = {
  id: EntityId;
  label: string;
  /** services whose tools may resolve this entity, or ["*"] for cross service */
  services: string[];
  /** exact leaf names, lowercased, that denote this entity */
  aliases: string[];
  /** object nouns appearing in a tool slug that imply the tool yields this entity */
  objectNouns: string[];
  /**
   * true when the value is an opaque handle a user cannot reasonably invent,
   * so obtaining it requires a prior tool call
   */
  opaque: boolean;
  notes?: string;
};

