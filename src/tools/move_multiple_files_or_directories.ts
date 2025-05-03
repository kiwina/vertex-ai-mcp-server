import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ToolDefinition, modelIdPlaceholder } from "./tool_definition.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Schema definition for moving multiple files/directories
export const MoveMultipleArgsSchema = z.object({
  moves: z
    .array(
      z.object({
        source: z
          .string()
          .describe(
            "The current path of the file or directory to move (relative to the workspace directory)."
          ),
        destination: z
          .string()
          .describe(
            "The new path for the file or directory (relative to the workspace directory)."
          ),
      })
    )
    .min(1)
    .describe(
      "An array of move operations, each specifying a source and destination path."
    ),
});

// Convert Zod schema to JSON schema
const MoveMultipleJsonSchema = zodToJsonSchema(MoveMultipleArgsSchema);

export const moveMultipleFilesOrDirectoriesTool: ToolDefinition = {
  name: "move_multiple_files_or_directories",
  description:
    "Move or rename multiple files and directories within the workspace filesystem in a single operation. " +
    "Each move operation specifies a source and destination. " +
    "If any destination path already exists, the corresponding move operation will likely fail (OS-dependent).",
  inputSchema: MoveMultipleJsonSchema as any, // Cast as any if needed

  // Minimal buildPrompt as execution logic is separate
  buildPrompt: (args: any, modelId: string) => {
    const parsed = MoveMultipleArgsSchema.safeParse(args);
    if (!parsed.success) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid arguments for move_multiple_files_or_directories: ${parsed.error}`
      );
    }

    // Add check: source and destination cannot be the same within any move pair
    for (const move of parsed.data.moves) {
      if (move.source === move.destination) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid arguments for move_multiple_files_or_directories: source and destination paths cannot be the same in pair: ${move.source} -> ${move.destination}`
        );
      }
    }

    // Check for duplicate sources or destinations which might cause conflicts
    const sources = new Set<string>();
    const destinations = new Set<string>();
    for (const move of parsed.data.moves) {
      if (sources.has(move.source)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid arguments for move_multiple_files_or_directories: Duplicate source path detected: ${move.source}`
        );
      }
      if (destinations.has(move.destination)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid arguments for move_multiple_files_or_directories: Duplicate destination path detected: ${move.destination}`
        );
      }
      // Also check if a source is another's destination or vice-versa within the same batch, which could lead to ambiguity
      if (destinations.has(move.source)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid arguments for move_multiple_files_or_directories: Source path ${move.source} is used as a destination in another move operation within the same request.`
        );
      }
      if (sources.has(move.destination)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid arguments for move_multiple_files_or_directories: Destination path ${move.destination} is used as a source in another move operation within the same request.`
        );
      }
      sources.add(move.source);
      destinations.add(move.destination);
    }

    return {
      systemInstructionText: "",
      userQueryText: "",
      useWebSearch: false,
      enableFunctionCalling: false,
    };
  },
  // No 'execute' function here
};
