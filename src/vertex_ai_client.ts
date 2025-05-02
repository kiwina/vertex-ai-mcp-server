import type {
  Content,
  GenerationConfig,
  SafetySetting,
  Tool,
  GenerateContentResponse,
  Part,
  FunctionCall,
  // Removed incorrect result/stream result types
} from "@google/genai";

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { getAIConfig } from "./config.js";
import { sleep } from "./utils.js";
import { GoogleGenAI } from "@google/genai";

// --- Configuration and Client Initialization ---
const aiConfig = getAIConfig();
let generativeClient: GoogleGenAI;

try {
  if (aiConfig.connectionMethod === "vertex") {
    if (!aiConfig.gcpProjectId || !aiConfig.gcpLocation) {
      throw new Error(
        "Missing GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_LOCATION for Vertex AI connection."
      );
    }
    generativeClient = new GoogleGenAI({
      vertexai: true,
      project: aiConfig.gcpProjectId,
      location: aiConfig.gcpLocation,
    });
    console.log(
      `Initialized @google/genai client via Vertex AI for project ${aiConfig.gcpProjectId} in ${aiConfig.gcpLocation}`
    );
  } else {
    // apiKey
    if (!aiConfig.geminiApiKey) {
      throw new Error("Missing GEMINI_API_KEY for API Key connection.");
    }
    generativeClient = new GoogleGenAI({ apiKey: aiConfig.geminiApiKey });
    console.log("Initialized @google/genai client via API Key");
  }
} catch (error: any) {
  console.error(
    `Error initializing @google/genai client (${aiConfig.connectionMethod}):`,
    error.message
  );
  process.exit(1);
}

// --- Unified AI Call Function ---
export async function callGenerativeAI(
  initialContents: Content[],
  tools: Tool[] | undefined
): Promise<string> {
  const {
    connectionMethod,
    modelId, // Use the specific modelId from config
    temperature,
    useStreaming,
    maxOutputTokens,
    maxRetries,
    retryDelayMs,
    safetySettings,
  } = aiConfig;

  const isGroundingRequested = tools?.some(
    (tool) => tool.googleSearchRetrieval
  );
  const hasFunctionCalling = tools?.some((tool) => tool.functionDeclarations);

  // Prepare GenerationConfig part
  const generationConfigPart: GenerationConfig = {
    temperature,
    maxOutputTokens,
  };

  // --- Execute Request with Retries ---
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      console.error(
        `[${new Date().toISOString()}] Calling GenAI (${connectionMethod}, ${modelId}, temp: ${temperature}, grounding: ${isGroundingRequested}, funcCall: ${hasFunctionCalling}, stream: ${useStreaming}, attempt: ${
          attempt + 1
        })`
      );

      let responseText: string | undefined;
      let finalResponse: GenerateContentResponse | undefined; // To hold the final response object

      // Use generativeClient.models directly
      const modelMethods = generativeClient.models;

      // Construct the request parameters object
      const requestParams = {
        model: modelId,
        contents: initialContents,
        tools,
        config: {
          // Apply config within this object
          generationConfig: generationConfigPart,
          safetySettings: safetySettings,
        },
      };

      if (useStreaming) {
        let accumulatedText = "";
        let aggregatedResponseFromStream: GenerateContentResponse | null = null;

        try {
          // Call generateContentStream with the structured requestParams
          const streamResult = await modelMethods.generateContentStream(
            requestParams
          );

          // Process the stream
          for await (const chunk of streamResult) {
            aggregatedResponseFromStream = chunk; // Keep track of the last chunk
            const blockReasonChunk = chunk.promptFeedback?.blockReason;
            if (blockReasonChunk) {
              throw new Error(
                `Content generation blocked during stream. Reason: ${blockReasonChunk}`
              );
            }
            const finishReasonChunk = chunk.candidates?.[0]?.finishReason;
            if (finishReasonChunk === "SAFETY") {
              throw new Error(
                `Content generation blocked during stream. Finish Reason: SAFETY`
              );
            }

            try {
              // Attempt to get text directly from chunk parts
              const chunkText =
                chunk.candidates?.[0]?.content?.parts?.[0]?.text;
              if (typeof chunkText === "string") {
                accumulatedText += chunkText;
              }
            } catch (e: any) {
              // Ignore errors, might be non-text part
            }
          }
          // Use the last chunk received as the 'final' response for checks
          finalResponse = aggregatedResponseFromStream ?? undefined;
        } catch (e: any) {
          console.error("Error during stream processing:", e.message);
          if (
            e.message?.toLowerCase().includes("safety") ||
            e.message?.toLowerCase().includes("blocked")
          ) {
            throw new Error(
              `Content generation blocked. Stream Error: ${e.message}`
            );
          }
          throw e;
        }

        // Check blocking/safety on the final chunk received
        const blockReasonFinal = finalResponse?.promptFeedback?.blockReason;
        if (blockReasonFinal) {
          throw new Error(
            `Content generation blocked. Final Stream Chunk Reason: ${blockReasonFinal}`
          );
        }
        const finishReasonFinal = finalResponse?.candidates?.[0]?.finishReason;
        if (
          finishReasonFinal &&
          finishReasonFinal !== "STOP" &&
          finishReasonFinal !== "FINISH_REASON_UNSPECIFIED"
        ) {
          if (finishReasonFinal === "SAFETY") {
            throw new Error(
              `Content generation blocked. Final Stream Chunk Finish Reason: SAFETY`
            );
          }
          console.warn(`Stream finished with reason: ${finishReasonFinal}`);
        }

        // If stream didn't accumulate text, try getting from the final chunk's parts
        if (!accumulatedText && finalResponse) {
          try {
            const finalText =
              finalResponse.candidates?.[0]?.content?.parts?.[0]?.text;
            if (typeof finalText === "string") {
              accumulatedText = finalText;
            }
          } catch (e) {
            console.warn(
              `Could not extract text from final stream chunk parts (may be normal if function call):`,
              e
            );
          }
        }
        responseText = accumulatedText;

        console.error(
          `[${new Date().toISOString()}] Finished processing stream from GenAI.`
        );
      } else {
        // Non-streaming
        try {
          // Call generateContent with the structured requestParams
          const result = await modelMethods.generateContent(requestParams);
          // The result *is* the response object
          finalResponse = result;
        } catch (e: any) {
          console.error("Error during non-streaming GenAI call:", e.message);
          if (
            e.message?.toLowerCase().includes("safety") ||
            e.message?.toLowerCase().includes("prompt blocked") ||
            e.message?.toLowerCase().includes("content blocked") ||
            (e as any).status === "BLOCKED"
          ) {
            throw new Error(
              `Content generation blocked. Call Reason: ${e.message}`
            );
          }
          throw e;
        }

        console.error(
          `[${new Date().toISOString()}] Received non-streaming response from GenAI.`
        );

        // Now 'finalResponse' holds the GenerateContentResponse
        const blockReason = finalResponse?.promptFeedback?.blockReason;
        if (blockReason) {
          throw new Error(
            `Content generation blocked. Response Reason: ${blockReason}`
          );
        }
        const finishReason = finalResponse?.candidates?.[0]?.finishReason;
        if (finishReason === "SAFETY") {
          throw new Error(
            `Content generation blocked. Response Finish Reason: SAFETY`
          );
        }

        try {
          // Get text directly from response parts
          const textFromParts =
            finalResponse?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (typeof textFromParts === "string") {
            responseText = textFromParts;
          }
        } catch (e) {
          console.warn(
            "Could not extract text from non-streaming response parts (may be normal if function call):",
            e
          );
        }
      }

      // --- Common Checks & Return ---

      // Check for function calls in the final response object
      const functionCallParts =
        finalResponse?.candidates?.[0]?.content?.parts?.filter(
          (part): part is Part & { functionCall: FunctionCall } =>
            !!part.functionCall
        );
      const hasFunctionCallResult =
        functionCallParts && functionCallParts.length > 0;

      // If we have neither text nor a function call, it's an error state
      if (
        (typeof responseText !== "string" || !responseText) &&
        !hasFunctionCallResult
      ) {
        console.error(
          `Empty response received and no function call detected. Final Response:`,
          JSON.stringify(finalResponse, null, 2)
        );
        throw new Error(
          `Received empty or non-text response without function call.`
        );
      }

      // Return the text, even if it's empty, as long as there might be a function call
      return responseText || "";
    } catch (error: any) {
      console.error(
        `[${new Date().toISOString()}] Error details (attempt ${attempt + 1}):`,
        error
      );
      const errorMessageString = String(
        error.message || error || ""
      ).toLowerCase();

      const isBlockingError =
        errorMessageString.includes("blocked") ||
        errorMessageString.includes("safety");

      const isRetryable =
        !isBlockingError &&
        (errorMessageString.includes("429") ||
          errorMessageString.includes("500") ||
          errorMessageString.includes("503") ||
          errorMessageString.includes("deadline_exceeded") ||
          errorMessageString.includes("internal") ||
          errorMessageString.includes("network error") ||
          errorMessageString.includes("socket hang up") ||
          errorMessageString.includes("unavailable") ||
          errorMessageString.includes("could not connect") ||
          errorMessageString.includes("connection refused"));

      if (isRetryable && attempt < maxRetries) {
        const jitter = Math.random() * 500;
        const delay = retryDelayMs * Math.pow(2, attempt) + jitter;
        console.error(
          `[${new Date().toISOString()}] Retrying in ${delay.toFixed(0)}ms...`
        );
        await sleep(delay);
        continue;
      } else {
        let finalErrorMessage = `GenAI API error: ${
          error.message || "Unknown error"
        }`;

        if (isBlockingError) {
          const reasonMatch = error.message?.match(
            /(Reason|Finish Reason):\s*(\w+)/i
          );
          const specificReason = reasonMatch?.[2] || "Safety Filter";
          finalErrorMessage = `Content generation blocked by ${specificReason}. (${error.message})`;
        } else if (errorMessageString.includes("429")) {
          finalErrorMessage = `GenAI API error: Rate limit exceeded (429). Please try again later.`;
        } else if (
          errorMessageString.match(/\b(500|503|internal|unavailable)\b/)
        ) {
          finalErrorMessage = `GenAI API error: Server error (${
            errorMessageString.match(/\b(500|503|internal|unavailable)\b/)?.[0]
          }). Please try again later. (${error.message})`;
        } else if (errorMessageString.includes("deadline_exceeded")) {
          finalErrorMessage = `GenAI API error: Operation timed out (deadline_exceeded).`;
        } else if (!isRetryable && attempt >= maxRetries) {
          finalErrorMessage = `GenAI API error after ${
            maxRetries + 1
          } attempts: ${error.message || "Unknown error"}`;
        }

        console.error("Final error message:", finalErrorMessage);
        throw new McpError(ErrorCode.InternalError, finalErrorMessage);
      }
    }
  } // End retry loop

  throw new McpError(
    ErrorCode.InternalError,
    `Max retries (${maxRetries + 1}) reached for GenAI call without success.`
  );
}
