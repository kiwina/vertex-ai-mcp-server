import { HarmCategory, HarmBlockThreshold } from "@google/genai";

// --- Determine Connection Method (Vertex AI or API Key) ---
// Use AI_PROVIDER to determine which connection method to use
export const GCLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT;
export const GCLOUD_LOCATION =
  process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
export const AI_PROVIDER = process.env.AI_PROVIDER?.toLowerCase() || "vertex"; // Default to vertex if not specified

// Determine the effective connection method
export type ConnectionMethod = "vertex" | "apiKey";
let connectionMethod: ConnectionMethod;

if (AI_PROVIDER === "vertex") {
  // Vertex AI mode requires GOOGLE_CLOUD_PROJECT
  if (!GCLOUD_PROJECT) {
    console.error(
      "Error: AI_PROVIDER is set to 'vertex' but GOOGLE_CLOUD_PROJECT is not defined. Please set GOOGLE_CLOUD_PROJECT for Vertex AI."
    );
    process.exit(1);
  }
  connectionMethod = "vertex";
} else if (AI_PROVIDER === "gemini") {
  // Gemini API Key mode requires GEMINI_API_KEY
  if (!GEMINI_API_KEY) {
    console.error(
      "Error: AI_PROVIDER is set to 'gemini' but GEMINI_API_KEY is not defined. Please set GEMINI_API_KEY for Gemini API access."
    );
    process.exit(1);
  }
  connectionMethod = "apiKey";
} else {
  // Invalid provider specified, try to fallback based on available credentials
  console.warn(
    `Warning: Invalid AI_PROVIDER value "${AI_PROVIDER}". Valid options are "vertex" or "gemini". Using fallback detection.`
  );

  if (GCLOUD_PROJECT) {
    console.warn("Using 'vertex' based on GOOGLE_CLOUD_PROJECT being set.");
    connectionMethod = "vertex";
  } else if (GEMINI_API_KEY) {
    console.warn("Using 'gemini' based on GEMINI_API_KEY being set.");
    connectionMethod = "apiKey";
  } else {
    console.error(
      "Error: No AI provider credentials found. Set either GOOGLE_CLOUD_PROJECT (for Vertex AI) or GEMINI_API_KEY (for Gemini API)."
    );
    process.exit(1);
  }
}

export const CONNECTION_METHOD = connectionMethod;

// --- Common AI Configuration Defaults ---
// Use a single default model, let environment variables override if needed
const DEFAULT_MODEL_ID = "gemini-2.5-pro-exp-03-25"; // Unified default
const DEFAULT_TEMPERATURE = 0.0;
const DEFAULT_USE_STREAMING = true;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;

export const WORKSPACE_ROOT = process.cwd();

// --- Safety Settings (Unified for @google/genai) ---
export const genaiSafetySettings = [
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
];

// --- Shared Config Retrieval ---
export function getAIConfig() {
  // Common parameters
  let temperature = DEFAULT_TEMPERATURE;
  const tempEnv = process.env.AI_TEMPERATURE;
  if (tempEnv) {
    const parsedTemp = parseFloat(tempEnv);
    // Temperature range varies, allow 0-2 for Gemini flexibility
    temperature =
      !isNaN(parsedTemp) && parsedTemp >= 0.0 && parsedTemp <= 2.0
        ? parsedTemp
        : DEFAULT_TEMPERATURE;
    if (temperature !== parsedTemp)
      console.warn(
        `Invalid AI_TEMPERATURE value "${tempEnv}". Using default: ${DEFAULT_TEMPERATURE}`
      );
  }

  let useStreaming = DEFAULT_USE_STREAMING;
  const streamEnv = process.env.AI_USE_STREAMING?.toLowerCase();
  if (streamEnv === "false") useStreaming = false;
  else if (streamEnv && streamEnv !== "true")
    console.warn(
      `Invalid AI_USE_STREAMING value "${streamEnv}". Using default: ${DEFAULT_USE_STREAMING}`
    );

  let maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
  const tokensEnv = process.env.AI_MAX_OUTPUT_TOKENS;
  if (tokensEnv) {
    const parsedTokens = parseInt(tokensEnv, 10);
    maxOutputTokens =
      !isNaN(parsedTokens) && parsedTokens > 0
        ? parsedTokens
        : DEFAULT_MAX_OUTPUT_TOKENS;
    if (maxOutputTokens !== parsedTokens)
      console.warn(
        `Invalid AI_MAX_OUTPUT_TOKENS value "${tokensEnv}". Using default: ${DEFAULT_MAX_OUTPUT_TOKENS}`
      );
  }

  let maxRetries = DEFAULT_MAX_RETRIES;
  const retriesEnv = process.env.AI_MAX_RETRIES;
  if (retriesEnv) {
    const parsedRetries = parseInt(retriesEnv, 10);
    maxRetries =
      !isNaN(parsedRetries) && parsedRetries >= 0
        ? parsedRetries
        : DEFAULT_MAX_RETRIES;
    if (maxRetries !== parsedRetries)
      console.warn(
        `Invalid AI_MAX_RETRIES value "${retriesEnv}". Using default: ${DEFAULT_MAX_RETRIES}`
      );
  }

  let retryDelayMs = DEFAULT_RETRY_DELAY_MS;
  const delayEnv = process.env.AI_RETRY_DELAY_MS;
  if (delayEnv) {
    const parsedDelay = parseInt(delayEnv, 10);
    retryDelayMs =
      !isNaN(parsedDelay) && parsedDelay >= 0
        ? parsedDelay
        : DEFAULT_RETRY_DELAY_MS;
    if (retryDelayMs !== parsedDelay)
      console.warn(
        `Invalid AI_RETRY_DELAY_MS value "${delayEnv}". Using default: ${DEFAULT_RETRY_DELAY_MS}`
      );
  }
  // Determine model ID - allow provider-specific model override via env vars, otherwise use default
  let modelId = DEFAULT_MODEL_ID;

  if (CONNECTION_METHOD === "vertex") {
    modelId =
      process.env.VERTEX_MODEL_ID ||
      process.env.AI_MODEL_ID ||
      DEFAULT_MODEL_ID;
  } else if (CONNECTION_METHOD === "apiKey") {
    modelId =
      process.env.GEMINI_MODEL_ID ||
      process.env.AI_MODEL_ID ||
      DEFAULT_MODEL_ID;
  }

  return {
    connectionMethod: CONNECTION_METHOD,
    provider: AI_PROVIDER,
    modelId,
    temperature,
    useStreaming,
    maxOutputTokens,
    maxRetries,
    retryDelayMs,
    safetySettings: genaiSafetySettings, // Use the unified settings
    // Connection info (pass both, client will use the relevant one)
    gcpProjectId: GCLOUD_PROJECT,
    gcpLocation: GCLOUD_LOCATION,
    geminiApiKey: GEMINI_API_KEY,
  };
}
