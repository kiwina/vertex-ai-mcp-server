// To run: bun run src/debug_wrapper.ts

import {
  Content,
  FunctionDeclaration,
  // FunctionDeclarationSchema, // Not exported from @google/genai
  Tool,
} from "@google/genai"; // Changed from @google/generative-ai
import { getAIConfig } from "./config.js";
import { answerQueryWebsearchTool } from "./tools/answer_query_websearch.js"; // Import the specific tool to test
import { buildApiPayload, ToolDefinition } from "./tools/tool_definition.js";
import { callGenerativeAI } from "./vertex_ai_client.js";

// --- Configuration ---
// 1. Select the tool definition you want to test
const toolToTest: ToolDefinition = answerQueryWebsearchTool; // Removed <any>

// 2. Provide sample arguments matching the tool's inputSchema
const sampleQueryArgs = {
  query: "What is the weather in Singapore today?",
};
// --- End Configuration ---

// Immediately Invoked Function Expression (IIFE) to allow async/await
(async () => {
  console.log(`Testing tool: ${toolToTest.name}`);
  console.log("Using arguments:", JSON.stringify(sampleQueryArgs, null, 2));
  console.log("---");

  try {
    // 1. Get Model ID from config
    const { modelId } = getAIConfig();
    if (!modelId) {
      throw new Error("Missing modelId in AI configuration.");
    }

    // 2. Build the prompt using the tool's method
    const promptDetails = toolToTest.buildPrompt(sampleQueryArgs, modelId);
    const {
      systemInstructionText,
      userQueryText,
      useWebSearch,
      enableFunctionCalling,
      // functionDeclarations: toolFunctionDeclarations // Assuming buildPrompt might return this in the future
    } = promptDetails;

    console.log("Prompt Details:");
    console.log(`  System Instruction: ${systemInstructionText || "None"}`);
    console.log(`  User Query: ${userQueryText}`);
    console.log(`  Use Web Search: ${useWebSearch}`);
    console.log(`  Enable Function Calling: ${enableFunctionCalling}`);
    console.log("---");

    // 3. Prepare arguments for callGenerativeAI
    // Use buildApiPayload to create the correct payload structure
    const payload = buildApiPayload(systemInstructionText, userQueryText);

    const tools: Tool[] = [];
    if (useWebSearch) {
      console.log("Adding Google Search tool...");
      tools.push({ googleSearch: {} });
    }

    if (enableFunctionCalling) {
      // TODO: Adjust this if tool definitions provide FunctionDeclaration[] directly
      // or if buildPrompt returns them. For now, adding an empty array if the flag is set.
      console.warn(
        "Function calling enabled by tool, but no function declarations found in the current ToolDefinition structure. Adding empty declarations."
      );
      // Assuming the tool definition itself might have the declarations in the future:
      // const declarations = toolToTest.functionDeclarations || [];
      const declarations: FunctionDeclaration[] = []; // Placeholder
      if (declarations.length > 0) {
        tools.push({ functionDeclarations: declarations });
      }
    }

    console.log("Calling callGenerativeAI...");
    // 4. Call the Vertex AI client function with the payload object
    const result = await callGenerativeAI(
      payload,
      tools.length > 0 ? tools : undefined
    );

    console.log("---");
    console.log("Result from callGenerativeAI:");
    console.log(result);
    console.log("---");
    console.log("Debug wrapper finished successfully.");
  } catch (error) {
    console.error("---");
    console.error("Error during debug wrapper execution:");
    if (error instanceof Error) {
      console.error(error.message);
      if (error.stack) {
        console.error(error.stack);
      }
    } else {
      console.error(error);
    }
    console.error("---");
    process.exit(1); // Exit with error code
  }
})();
