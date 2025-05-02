import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
// Import Content and Part types correctly
import { Content, Tool, Part } from "@google/genai";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: any; // Consider defining a stricter type like JSONSchema7
  buildPrompt: (
    args: any,
    modelId: string
  ) => {
    systemInstructionText: string;
    userQueryText: string;
    useWebSearch: boolean;
    enableFunctionCalling: boolean;
  };
}

export const modelIdPlaceholder = "${modelId}"; // Placeholder for dynamic model ID in descriptions

// Define the structure for the payload passed to callGenerativeAI
export interface GenerativeAIRequestPayload {
  contents: Content[];
  systemInstruction?: Content; // Make optional for cases without system instructions
}

// Helper to build the payload object for callGenerativeAI
export function buildApiPayload(
  systemInstructionText: string | undefined, // Allow undefined system instruction
  userQueryText: string
): GenerativeAIRequestPayload {
  const payload: GenerativeAIRequestPayload = {
    contents: [{ role: "user", parts: [{ text: userQueryText }] }],
  };
  // Only add systemInstruction if text is provided
  if (systemInstructionText) {
    payload.systemInstruction = {
      // role: "system", // Role is implicit for systemInstruction field
      parts: [{ text: systemInstructionText }],
    };
  }
  return payload;
}

// Helper to determine tools for API call
export function getToolsForApi(
  enableFunctionCalling: boolean,
  useWebSearch: boolean
): Tool[] | undefined {
  // Function calling is no longer supported by the remaining tools
  return useWebSearch ? [{ googleSearch: {} } as any] : undefined; // Cast needed as SDK type might not include googleSearch directly
}
