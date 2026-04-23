import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const schema = z.object({
  frontmatter: z.record(z.any()).optional(),
}).passthrough();

console.log(JSON.stringify(zodToJsonSchema(schema), null, 2));
