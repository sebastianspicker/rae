import { badInput } from "@coding-agents-space/shared";
import type { Input } from "../types.js";

export function validateInput(input: Input): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw badInput("input must be an object");
  }
  if (!input.run_id || typeof input.run_id !== "string") {
    throw badInput("run_id is required");
  }
  if (input.trace_path !== undefined && typeof input.trace_path !== "string") {
    throw badInput("trace_path must be a string when provided");
  }
  if (input.schema_ref !== undefined && typeof input.schema_ref !== "string") {
    throw badInput("schema_ref must be a string when provided");
  }
  if (!input.trace_path && (!Array.isArray(input.events) || input.events.length === 0)) {
    throw badInput("Provide either trace_path or non-empty events array");
  }
  if (input.events !== undefined && !Array.isArray(input.events)) {
    throw badInput("events must be an array when provided");
  }
}
