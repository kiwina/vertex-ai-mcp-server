/**
 * Common utility functions for MCP server
 */

/**
 * Sleep for a specified number of milliseconds
 */
export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Collection of filesystem tool names for easy checking
 */
export const filesystemToolNames = new Set([
  "read_file_content",
  "read_multiple_files_content",
  "write_file_content",
  "edit_file_content",
  "create_directory",
  "list_directory_contents",
  "get_directory_tree",
  "move_file_or_directory",
  "search_filesystem",
  "get_filesystem_info",
]);

/**
 * Collection of save/generate tool names
 */
export const saveGenerateToolNames = new Set([
  "save_generate_project_guidelines",
  "save_doc_snippet",
  "save_topic_explanation",
  "save_answer_query_direct",
  "save_answer_query_websearch",
]);

/**
 * Format a timestamp for console logging
 */
export function formatTimestamp(): string {
  return `[${new Date().toISOString()}]`;
}

/**
 * Log a formatted message with timestamp
 */
export function logMessage(message: string, ...params: any[]): void {
  console.error(`${formatTimestamp()} ${message}`, ...params);
}
