/**
 * deps.ts
 *
 * This module re-exports the required methods from the dependencies.
 */

export { BufReader, StringReader } from "https://deno.land/std@0.140.0/io/mod.ts";
export * from "https://deno.land/std@0.140.0/streams/conversion.ts";

import * as log from "https://deno.land/std@0.136.0/log/mod.ts";
export { log };
