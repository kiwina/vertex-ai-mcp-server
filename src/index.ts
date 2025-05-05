#!/usr/bin/env node

import dotenv from "dotenv";
import path from "path";

// Load .env file from the current working directory (where npx/node is run)
// This ensures it works correctly when run via npx outside the project dir
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// Import config and tools
import { getAIConfig } from "./config.js";
import { allTools, toolMap } from "./tools/index.js";

// Import utility functions from the new utils directory
import {
  filesystemToolNames,
  saveGenerateToolNames,
  logMessage,
  handleSaveGenerateTool,
  handleFilesystemTool,
  handleGenericAITool,
} from "./utils/index.js";

// --- MCP Server Setup ---
const server = new Server(
  { name: "vertex-ai-mcp-server", version: "0.5.0" },
  { capabilities: { tools: {} } }
);

// --- Tool Definitions Handler ---
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const config = getAIConfig();
  return {
    tools: allTools.map((t) => ({
      name: t.name,
      description: t.description.replace("${modelId}", config.modelId),
      inputSchema: t.inputSchema,
    })),
  };
});

// --- Tool Call Handler ---
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = request.params.arguments ?? {};

  const toolDefinition = toolMap.get(toolName);
  if (!toolDefinition) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
  }

  try {
    // --- Handle Save/Generate Tools ---
    if (saveGenerateToolNames.has(toolName)) {
      return await handleSaveGenerateTool(toolName, args, toolDefinition);
    }
    // --- Handle Filesystem Tools ---
    else if (filesystemToolNames.has(toolName)) {
      return await handleFilesystemTool(toolName, args);
    }
    // --- Handle Generic AI Tools ---
    else {
      return await handleGenericAITool(toolName, args, toolDefinition);
    }
  } catch (error) {
    // Centralized error handling
    if (error instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid arguments for ${toolName}: ${error.errors
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join(", ")}`
      );
    } else if (error instanceof McpError) {
      throw error;
    } else if (error instanceof Error && error.message.includes("ENOENT")) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Path not found for tool ${toolName}: ${error.message}`
      );
    } else {
      logMessage(`Unexpected error in tool handler (${toolName}):`, error);
      throw new McpError(
        ErrorCode.InternalError,
        `Unexpected server error during ${toolName}: ${
          (error as Error).message || "Unknown"
        }`
      );
    }
  }
});

// --- Server Start ---
async function main() {
  const transport = new StdioServerTransport();
  logMessage("vertex-ai-mcp-server connecting via stdio...");
  await server.connect(transport);
  logMessage("vertex-ai-mcp-server connected.");
}

main().catch((error) => {
  logMessage("Server failed to start:", error);
  process.exit(1);
});

// --- Graceful Shutdown ---
const shutdown = async (signal: string) => {
  logMessage(`Received ${signal}. Shutting down server...`);
  try {
    await server.close();
    logMessage("Server shut down gracefully.");
    process.exit(0);
  } catch (shutdownError) {
    logMessage("Error during server shutdown:", shutdownError);
    process.exit(1);
  }
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
