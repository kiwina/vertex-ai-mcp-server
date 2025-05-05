import type {
  Content,
  GenerationConfig,
  SafetySetting,
  Tool,
  GenerateContentResponse,
  Part,
  FunctionCall,
} from "@google/genai";

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { getAIConfig } from "./config.js";
import { sleep } from "./utils/common.js";
import { GoogleGenAI } from "@google/genai";
import { GoogleAuthOptions } from "google-auth-library";
import { GenerativeAIRequestPayload } from "./tools/tool_definition.js";

/**
 * Represents possible error types during AI generation
 */
enum AIErrorType {
  Safety = "safety",
  RateLimit = "rate_limit",
  ServerError = "server_error",
  Timeout = "timeout",
  Network = "network",
  Unknown = "unknown",
}

/**
 * Interface representing a structured error from the AI service
 */
interface AIServiceError {
  type: AIErrorType;
  message: string;
  retryable: boolean;
  originalError: any;
}

/**
 * Logger implementation for consistent logging format and levels
 */
class Logger {
  static info(message: string, ...args: any[]): void {
    console.log(`[${new Date().toISOString()}] INFO: ${message}`, ...args);
  }

  static warn(message: string, ...args: any[]): void {
    console.warn(`[${new Date().toISOString()}] WARN: ${message}`, ...args);
  }

  static error(message: string, ...args: any[]): void {
    console.error(`[${new Date().toISOString()}] ERROR: ${message}`, ...args);
  }

  static debug(message: string, ...args: any[]): void {
    if (process.env.DEBUG) {
      console.debug(`[${new Date().toISOString()}] DEBUG: ${message}`, ...args);
    }
  }
}

// --- Configuration and Client Initialization ---
// Default client will be initialized on first use or can be explicitly initialized with specific config
let generativeClient: GoogleGenAI | undefined;

/**
 * Initialize or reinitialize the GoogleGenAI client with the provided config
 *
 * @param customConfig - Custom configuration (optional, defaults to current config from getAIConfig())
 * @param googleAuthOptions - Optional Google Auth options for custom authentication
 * @returns Initialized GoogleGenAI client
 * @throws McpError if initialization fails
 */
export function initializeAIClient(
  customConfig = getAIConfig(),
  googleAuthOptions?: GoogleAuthOptions
): GoogleGenAI {
  try {
    if (customConfig.connectionMethod === "vertex") {
      if (!customConfig.gcpProjectId || !customConfig.gcpLocation) {
        throw new Error(
          "Missing GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_LOCATION for Vertex AI connection."
        );
      }

      // Initialize client with Vertex AI parameters
      const clientOptions: any = {
        vertexai: true,
        project: customConfig.gcpProjectId,
        location: customConfig.gcpLocation,
      };

      // Add googleAuthOptions if provided (enables using service account credentials directly)
      if (googleAuthOptions) {
        clientOptions.googleAuthOptions = googleAuthOptions;
        Logger.info("Using provided Google Auth options for authentication");
      } else {
        // If GOOGLE_APPLICATION_CREDENTIALS is set in the environment,
        // it will be automatically used by the client
        const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        if (credentialsPath) {
          Logger.info(
            `Using credentials from GOOGLE_APPLICATION_CREDENTIALS: ${credentialsPath}`
          );
        } else {
          Logger.info(
            "Using Application Default Credentials (ADC) for authentication"
          );
        }
      }

      generativeClient = new GoogleGenAI(clientOptions);
      Logger.info(
        `Initialized @google/genai client via Vertex AI for project ${customConfig.gcpProjectId} in ${customConfig.gcpLocation}`
      );
    } else {
      // apiKey
      if (!customConfig.geminiApiKey) {
        throw new Error("Missing GEMINI_API_KEY for API Key connection.");
      }
      generativeClient = new GoogleGenAI({
        vertexai: false,
        apiKey: customConfig.geminiApiKey,
      });
      Logger.info(
        `Initialized @google/genai client via API Key (${customConfig.provider})`
      );
    }
    return generativeClient;
  } catch (error: any) {
    Logger.error(
      `Error initializing @google/genai client (${customConfig.connectionMethod}):`,
      error.message
    );
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to initialize AI client: ${error.message}`
    );
  }
}

// Initialize the default client
try {
  const aiConfig = getAIConfig();
  generativeClient = initializeAIClient(aiConfig);
} catch (error: any) {
  Logger.error(`Fatal error initializing default AI client:`, error.message);
  process.exit(1);
}

/**
 * Build the parameters for the API request
 *
 * @param payload - The payload containing content and system instructions
 * @param tools - Optional tools for the model
 * @param modelId - The model ID to use
 * @param generationConfig - Generation configuration
 * @param safetySettings - Safety settings configuration
 * @returns Request parameters object
 */
function buildRequestParameters(
  payload: GenerativeAIRequestPayload,
  tools: Tool[] | undefined,
  modelId: string,
  generationConfig: GenerationConfig,
  safetySettings: SafetySetting[]
) {
  const requestParams = {
    model: modelId,
    contents: payload.contents,
    systemInstruction: payload.systemInstruction,
    config: {
      tools,
      generationConfig,
      safetySettings,
    },
  };

  // Remove undefined systemInstruction if present (API might error)
  if (requestParams.systemInstruction === undefined) {
    delete requestParams.systemInstruction;
  }

  return requestParams;
}

/**
 * Process a response error and categorize it
 *
 * @param error - The error object from the API call
 * @returns Structured AIServiceError with type and retry information
 */
function processResponseError(error: any): AIServiceError {
  const errorMessage = String(error.message || error || "").toLowerCase();

  // Determine error type
  let type = AIErrorType.Unknown;
  let retryable = false;

  if (errorMessage.includes("blocked") || errorMessage.includes("safety")) {
    type = AIErrorType.Safety;
    retryable = false;
  } else if (errorMessage.includes("429")) {
    type = AIErrorType.RateLimit;
    retryable = true;
  } else if (
    errorMessage.match(/\b(500|503|internal|unavailable)\b/) ||
    errorMessage.includes("server error")
  ) {
    type = AIErrorType.ServerError;
    retryable = true;
  } else if (
    errorMessage.includes("deadline_exceeded") ||
    errorMessage.includes("timeout")
  ) {
    type = AIErrorType.Timeout;
    retryable = true;
  } else if (
    errorMessage.includes("network error") ||
    errorMessage.includes("socket hang up") ||
    errorMessage.includes("could not connect") ||
    errorMessage.includes("connection refused")
  ) {
    type = AIErrorType.Network;
    retryable = true;
  }

  return {
    type,
    message: error.message || "Unknown error",
    retryable,
    originalError: error,
  };
}

/**
 * Format an error message based on the error type
 *
 * @param error - The structured error object
 * @returns Formatted error message
 */
function formatErrorMessage(error: AIServiceError): string {
  switch (error.type) {
    case AIErrorType.Safety:
      const reasonMatch = error.message.match(
        /(Reason|Finish Reason):\s*(\w+)/i
      );
      const specificReason = reasonMatch?.[2] || "Safety Filter";
      return `Content generation blocked by ${specificReason}. (${error.message})`;

    case AIErrorType.RateLimit:
      return `GenAI API error: Rate limit exceeded (429). Please try again later.`;

    case AIErrorType.ServerError:
      const errorCode = error.message.match(
        /\b(500|503|internal|unavailable)\b/
      )?.[0];
      return `GenAI API error: Server error (${errorCode}). Please try again later. (${error.message})`;

    case AIErrorType.Timeout:
      return `GenAI API error: Operation timed out (deadline_exceeded).`;

    default:
      return `GenAI API error: ${error.message || "Unknown error"}`;
  }
}

/**
 * Process a single chunk from streaming response
 *
 * @param chunk - The response chunk
 * @returns The text extracted from the chunk if available
 * @throws Error if the content is blocked
 */
function processStreamChunk(
  chunk: GenerateContentResponse
): string | undefined {
  // Check for content blocking
  const blockReason = chunk.promptFeedback?.blockReason;
  if (blockReason) {
    throw new Error(
      `Content generation blocked during stream. Reason: ${blockReason}`
    );
  }

  const finishReason = chunk.candidates?.[0]?.finishReason;
  if (finishReason === "SAFETY") {
    throw new Error(
      `Content generation blocked during stream. Finish Reason: SAFETY`
    );
  }

  // Extract text if available
  try {
    const chunkText = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
    return typeof chunkText === "string" ? chunkText : undefined;
  } catch (e) {
    // Ignore errors, might be a non-text part
    return undefined;
  }
}

/**
 * Process a stream result from the AI service
 *
 * @param streamResult - The stream result iterator
 * @returns Object containing accumulated text and final response
 * @throws Error if content is blocked
 */
async function processStreamResponse(
  streamResult: AsyncIterable<GenerateContentResponse>
): Promise<{
  text: string;
  finalResponse: GenerateContentResponse | undefined;
}> {
  let accumulatedText = "";
  let lastResponse: GenerateContentResponse | null = null;

  try {
    for await (const chunk of streamResult) {
      lastResponse = chunk;
      const chunkText = processStreamChunk(chunk);
      if (chunkText) {
        accumulatedText += chunkText;
      }
    }
  } catch (e: any) {
    Logger.error("Error during stream processing:", e.message);
    if (
      e.message?.toLowerCase().includes("safety") ||
      e.message?.toLowerCase().includes("blocked")
    ) {
      throw new Error(`Content generation blocked. Stream Error: ${e.message}`);
    }
    throw e;
  }

  // Final check on the last chunk
  if (lastResponse) {
    const blockReasonFinal = lastResponse.promptFeedback?.blockReason;
    if (blockReasonFinal) {
      throw new Error(
        `Content generation blocked. Final Stream Chunk Reason: ${blockReasonFinal}`
      );
    }

    const finishReasonFinal = lastResponse.candidates?.[0]?.finishReason;
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
      Logger.warn(`Stream finished with reason: ${finishReasonFinal}`);
    }

    // If we don't have accumulated text, try to extract it from the final response
    if (!accumulatedText) {
      try {
        const finalText =
          lastResponse.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof finalText === "string") {
          accumulatedText = finalText;
        }
      } catch (e) {
        Logger.warn(
          `Could not extract text from final stream chunk parts (may be normal if function call):`,
          e
        );
      }
    }
  }

  return {
    text: accumulatedText,
    finalResponse: lastResponse || undefined,
  };
}

/**
 * Process a non-streaming response from the AI service
 *
 * @param modelMethods - The model methods object
 * @param requestParams - Request parameters
 * @returns Object containing response text and final response object
 * @throws Error if content is blocked
 */
async function processNonStreamingResponse(
  modelMethods: any,
  requestParams: any
): Promise<{
  text: string | undefined;
  finalResponse: GenerateContentResponse;
}> {
  try {
    const result = await modelMethods.generateContent(requestParams);

    // Check for content blocking
    const blockReason = result.promptFeedback?.blockReason;
    if (blockReason) {
      throw new Error(
        `Content generation blocked. Response Reason: ${blockReason}`
      );
    }

    const finishReason = result.candidates?.[0]?.finishReason;
    if (finishReason === "SAFETY") {
      throw new Error(
        `Content generation blocked. Response Finish Reason: SAFETY`
      );
    }

    // Extract text content
    let responseText: string | undefined;
    try {
      const textFromParts = result.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof textFromParts === "string") {
        responseText = textFromParts;
      }
    } catch (e) {
      Logger.warn(
        "Could not extract text from non-streaming response parts (may be normal if function call):",
        e
      );
    }

    return {
      text: responseText,
      finalResponse: result,
    };
  } catch (e: any) {
    Logger.error("Error during non-streaming GenAI call:", e.message);
    if (
      e.message?.toLowerCase().includes("safety") ||
      e.message?.toLowerCase().includes("prompt blocked") ||
      e.message?.toLowerCase().includes("content blocked") ||
      (e as any).status === "BLOCKED"
    ) {
      throw new Error(`Content generation blocked. Call Reason: ${e.message}`);
    }
    throw e;
  }
}

/**
 * Check if the response contains function calls
 *
 * @param response - The AI response object
 * @returns Boolean indicating if function calls were found
 */
function hasFunctionCallsInResponse(
  response: GenerateContentResponse | undefined
): boolean {
  if (!response) return false;

  const functionCallParts = response.candidates?.[0]?.content?.parts?.filter(
    (part): part is Part & { functionCall: FunctionCall } => !!part.functionCall
  );

  return Boolean(functionCallParts && functionCallParts.length > 0);
}

/**
 * Call the Generative AI model with the provided payload and tools
 *
 * This function handles both streaming and non-streaming requests to the AI model,
 * as well as retries with exponential backoff in case of temporary failures.
 *
 * @param payload - Request payload containing the contents and optional system instructions
 * @param tools - Optional tools for the model (function calling, search grounding, etc.)
 * @param customConfig - Optional custom configuration to override the default
 * @returns Promise resolving to the generated text content
 * @throws McpError for any irrecoverable errors
 */
export async function callGenerativeAI(
  payload: GenerativeAIRequestPayload,
  tools: Tool[] | undefined,
  customConfig?: ReturnType<typeof getAIConfig>
): Promise<string> {
  // Use provided custom config or get the current default
  const config = customConfig || getAIConfig();
  const {
    connectionMethod,
    modelId,
    temperature,
    useStreaming,
    maxOutputTokens,
    maxRetries,
    retryDelayMs,
    safetySettings,
  } = config;

  // Ensure we have a client that matches the config
  if (
    !generativeClient ||
    (customConfig &&
      customConfig.connectionMethod !== getAIConfig().connectionMethod)
  ) {
    generativeClient = initializeAIClient(config);
  }

  // Feature detection from tools
  const isGroundingRequested = tools?.some((tool) => tool.googleSearch);
  const hasFunctionCalling = tools?.some((tool) => tool.functionDeclarations);

  // Prepare generation config
  const generationConfigPart: GenerationConfig = {
    temperature,
    maxOutputTokens,
  };

  // --- Execute Request with Retries ---
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      Logger.info(
        `Calling GenAI (${connectionMethod}, ${modelId}, temp: ${temperature}, grounding: ${isGroundingRequested}, funcCall: ${hasFunctionCalling}, stream: ${useStreaming}, attempt: ${
          attempt + 1
        })`
      );

      // Ensure client is initialized
      if (!generativeClient) {
        generativeClient = initializeAIClient(config);
      }

      // Access model methods from client
      const modelMethods = generativeClient.models;

      // Build the request parameters
      const requestParams = buildRequestParameters(
        payload,
        tools,
        modelId,
        generationConfigPart,
        safetySettings
      );

      Logger.debug(
        "Request Params for GenAI:",
        JSON.stringify(requestParams, null, 2)
      );

      // Process request based on streaming preference
      let responseText: string | undefined;
      let finalResponse: GenerateContentResponse | undefined;

      if (useStreaming) {
        // Streaming mode
        const streamResult = await modelMethods.generateContentStream(
          requestParams
        );
        const streamResponse = await processStreamResponse(streamResult);

        responseText = streamResponse.text;
        finalResponse = streamResponse.finalResponse;

        Logger.info(`Finished processing stream from GenAI.`);
      } else {
        // Non-streaming mode
        const result = await processNonStreamingResponse(
          modelMethods,
          requestParams
        );

        responseText = result.text;
        finalResponse = result.finalResponse;

        Logger.info(`Received non-streaming response from GenAI.`);
      }

      // Check if response has function calls
      const hasFunctionCallResult = hasFunctionCallsInResponse(finalResponse);

      // Validate response has at least text or function call
      if (!responseText && !hasFunctionCallResult) {
        Logger.error(
          `Empty response received and no function call detected. Final Response:`,
          JSON.stringify(finalResponse, null, 2)
        );
        throw new Error(
          `Received empty or non-text response without function call.`
        );
      }

      // Return text content (possibly empty if there's a function call)
      return responseText || "";
    } catch (error: any) {
      Logger.error(`Error details (attempt ${attempt + 1}):`, error);

      // Process the error to determine if it's retryable
      const processedError = processResponseError(error);

      // Handle retry logic
      if (processedError.retryable && attempt < maxRetries) {
        const jitter = Math.random() * 500;
        const delay = retryDelayMs * Math.pow(2, attempt) + jitter;
        Logger.info(`Retrying in ${delay.toFixed(0)}ms...`);
        await sleep(delay);
        continue;
      } else {
        // Format a user-friendly error message
        const finalErrorMessage = formatErrorMessage(processedError);

        Logger.error("Final error message:", finalErrorMessage);
        throw new McpError(ErrorCode.InternalError, finalErrorMessage);
      }
    }
  } // End retry loop

  // This should only happen if we've exhausted all retries without success
  throw new McpError(
    ErrorCode.InternalError,
    `Max retries (${maxRetries + 1}) reached for GenAI call without success.`
  );
}
