/**
 * Tool handler functions for MCP server
 */

import fs from "fs/promises";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { buildApiPayload, getToolsForApi } from "../tools/tool_definition.js";
import { callGenerativeAI } from "../vertex_ai_client.js";
import { getAIConfig } from "../config.js";

// Import all the utility functions
import {
  validateWorkspacePath,
  getFileStats,
  searchFilesRecursive,
  applyFileEdits,
  buildDirectoryTree,
} from "./filesystem.js";

// Import all schemas
import { ReadFileArgsSchema } from "../tools/read_file.js";
// import { ReadMultipleFilesArgsSchema } from "../tools/read_multiple_files.js"; // Removed
import { WriteFileArgsSchema } from "../tools/write_file.js";
import { EditFileArgsSchema } from "../tools/edit_file.js";
// import { CreateDirectoryArgsSchema } from "../tools/create_directory.js"; // Removed
import { ListDirectoryArgsSchema } from "../tools/list_directory.js";
import { DirectoryTreeArgsSchema } from "../tools/directory_tree.js";
import { MoveFileArgsSchema } from "../tools/move_file.js";
import { SearchFilesArgsSchema } from "../tools/search_files.js";
import { GetFileInfoArgsSchema } from "../tools/get_file_info.js";
import { SaveGenerateProjectGuidelinesArgsSchema } from "../tools/save_generate_project_guidelines.js";
import { SaveDocSnippetArgsSchema } from "../tools/save_doc_snippet.js";
import { SaveTopicExplanationArgsSchema } from "../tools/save_topic_explanation.js";
import { SaveAnswerQueryDirectArgsSchema } from "../tools/save_answer_query_direct.js";
import { SaveAnswerQueryWebsearchArgsSchema } from "../tools/save_answer_query_websearch.js";

/**
 * Handle save/generate tools
 */
export async function handleSaveGenerateTool(
  toolName: string,
  args: any,
  toolDefinition: any
) {
  // Parse arguments based on tool type
  const parsedArgs = (() => {
    switch (toolName) {
      case "save_generate_project_guidelines":
        return SaveGenerateProjectGuidelinesArgsSchema.parse(args);
      case "save_doc_snippet":
        return SaveDocSnippetArgsSchema.parse(args);
      case "save_topic_explanation":
        return SaveTopicExplanationArgsSchema.parse(args);
      case "save_answer_query_direct":
        return SaveAnswerQueryDirectArgsSchema.parse(args);
      case "save_answer_query_websearch":
        return SaveAnswerQueryWebsearchArgsSchema.parse(args);
      default:
        throw new McpError(
          ErrorCode.InvalidParams,
          `Unknown save/generate tool: ${toolName}`
        );
    }
  })();

  // Extract output path which is common to all save/generate tools
  const outputPath = parsedArgs.output_path;

  // Get config and build prompt
  let config = getAIConfig();
  const {
    systemInstructionText,
    userQueryText,
    useWebSearch,
    enableFunctionCalling,
  } = toolDefinition.buildPrompt(args, config.modelId);

  // If useWebSearch is true, use Gemini API instead of Vertex AI
  if (useWebSearch && process.env.GEMINI_API_KEY) {
    console.log(`Using Gemini API for web search in tool: ${toolName}`);
    config = {
      ...config,
      connectionMethod: "apiKey",
      provider: "gemini",
      modelId: process.env.GEMINI_MODEL_ID || config.modelId,
    };
  }

  const payload = buildApiPayload(systemInstructionText, userQueryText);
  const toolsForApi = getToolsForApi(enableFunctionCalling, useWebSearch);

  // Call the AI with appropriate config
  const generatedContent = await callGenerativeAI(payload, toolsForApi, config);

  // Save the generated content
  const validOutputPath = validateWorkspacePath(outputPath);
  await fs.mkdir(path.dirname(validOutputPath), { recursive: true });
  await fs.writeFile(validOutputPath, generatedContent, "utf-8");

  return {
    content: [
      {
        type: "text",
        text: `Successfully generated content and saved to ${outputPath}`,
      },
    ],
  };
}

/**
 * Handle filesystem tools
 */
export async function handleFilesystemTool(toolName: string, args: any) {
  let resultText = "";
  switch (toolName) {
    case "read_file_content": {
      const parsed = ReadFileArgsSchema.parse(args);
      if (typeof parsed.paths === "string") {
        // Handle single file read
        const validPath = validateWorkspacePath(parsed.paths);
        const content = await fs.readFile(validPath, "utf-8");
        resultText = content;
      } else {
        // Handle multiple file read (similar to old read_multiple_files_content)
        const results = await Promise.all(
          parsed.paths.map(async (filePath: string) => {
            try {
              const validPath = validateWorkspacePath(filePath);
              const content = await fs.readFile(validPath, "utf-8");
              return `${path.relative(
                process.cwd(),
                validPath
              )}:\n${content}\n`;
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              return `${filePath}: Error - ${errorMessage}`;
            }
          })
        );
        resultText = results.join("\n---\n");
      }
      break;
    }
    // case "read_multiple_files_content": removed - functionality merged into read_file_content
    case "write_file_content": {
      const parsed = WriteFileArgsSchema.parse(args);
      // Access the 'writes' property which contains either a single object or an array
      const writeOperations = Array.isArray(parsed.writes)
        ? parsed.writes
        : [parsed.writes];
      const results: string[] = [];

      for (const op of writeOperations) {
        try {
          const validPath = validateWorkspacePath(op.path);
          await fs.mkdir(path.dirname(validPath), { recursive: true });
          await fs.writeFile(validPath, op.content, "utf-8");
          results.push(`Successfully wrote to ${op.path}`);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          results.push(`Error writing to ${op.path}: ${errorMessage}`);
        }
      }
      resultText = results.join("\n");
      break;
    }
    case "edit_file_content": {
      const parsed = EditFileArgsSchema.parse(args);
      if (parsed.edits.length === 0) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `'edits' array cannot be empty for ${toolName}.`
        );
      }
      const validPath = validateWorkspacePath(parsed.path);
      resultText = await applyFileEdits(validPath, parsed.edits, parsed.dryRun);
      break;
    } // case "create_directory": removed
    case "list_directory_contents": {
      const parsed = ListDirectoryArgsSchema.parse(args);
      const validPath = validateWorkspacePath(parsed.path);
      const entries = await fs.readdir(validPath, { withFileTypes: true });
      resultText = entries
        .map(
          (entry) =>
            `${entry.isDirectory() ? "[DIR] " : "[FILE]"} ${entry.name}`
        )
        .sort()
        .join("\n");
      if (!resultText) resultText = "(Directory is empty)";
      break;
    }
    case "get_directory_tree": {
      const parsed = DirectoryTreeArgsSchema.parse(args);
      const validPath = validateWorkspacePath(parsed.path);
      const treeData = await buildDirectoryTree(validPath);
      resultText = JSON.stringify(treeData, null, 2);
      break;
    }
    case "move_file_or_directory": {
      const parsed = MoveFileArgsSchema.parse(args);
      if (parsed.source === parsed.destination) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Source and destination paths cannot be the same for ${toolName}.`
        );
      }
      const validSourcePath = validateWorkspacePath(parsed.source);
      const validDestPath = validateWorkspacePath(parsed.destination);
      await fs.mkdir(path.dirname(validDestPath), { recursive: true });
      await fs.rename(validSourcePath, validDestPath);
      resultText = `Successfully moved ${parsed.source} to ${parsed.destination}`;
      break;
    }
    case "search_filesystem": {
      const parsed = SearchFilesArgsSchema.parse(args);
      const validPath = validateWorkspacePath(parsed.path);
      const results: string[] = [];
      await searchFilesRecursive(
        validPath,
        validPath,
        parsed.pattern,
        parsed.excludePatterns,
        results
      );
      resultText = results.length > 0 ? results.join("\n") : "No matches found";
      break;
    }
    case "get_filesystem_info": {
      const parsed = GetFileInfoArgsSchema.parse(args);
      const validPath = validateWorkspacePath(parsed.path);
      const info = await getFileStats(validPath);
      resultText = `Path: ${parsed.path}\nType: ${
        info.isDirectory ? "Directory" : "File"
      }\nSize: ${
        info.size
      } bytes\nCreated: ${info.created.toISOString()}\nModified: ${info.modified.toISOString()}\nAccessed: ${info.accessed.toISOString()}\nPermissions: ${
        info.permissions
      }`;
      break;
    }
  }

  return {
    content: [{ type: "text", text: resultText }],
  };
}

/**
 * Handle generic AI tools
 */
export async function handleGenericAITool(
  toolName: string,
  args: any,
  toolDefinition: any
) {
  if (!toolDefinition.buildPrompt) {
    throw new McpError(
      ErrorCode.MethodNotFound,
      `Tool ${toolName} is missing required buildPrompt logic.`
    );
  }

  // Get config and build prompt
  let config = getAIConfig();
  const {
    systemInstructionText,
    userQueryText,
    useWebSearch,
    enableFunctionCalling,
  } = toolDefinition.buildPrompt(args, config.modelId);

  // If useWebSearch is true, use Gemini API instead of Vertex AI
  if (useWebSearch && process.env.GEMINI_API_KEY) {
    console.log(`Using Gemini API for web search in tool: ${toolName}`);
    config = {
      ...config,
      connectionMethod: "apiKey",
      provider: "gemini",
      modelId: process.env.GEMINI_MODEL_ID || config.modelId,
    };
  }

  const payload = buildApiPayload(systemInstructionText, userQueryText);
  const toolsForApi = getToolsForApi(enableFunctionCalling, useWebSearch);

  // Call the AI with appropriate config
  const responseText = await callGenerativeAI(payload, toolsForApi, config);

  return {
    content: [{ type: "text", text: responseText }],
  };
}
