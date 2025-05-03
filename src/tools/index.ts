import { ToolDefinition } from "./tool_definition.js";
import { answerQueryWebsearchTool } from "./answer_query_websearch.js";
import { answerQueryDirectTool } from "./answer_query_direct.js";
import { explainTopicWithDocsTool } from "./explain_topic_with_docs.js";
import { getDocSnippetsTool } from "./get_doc_snippets.js";
import { generateProjectGuidelinesTool } from "./generate_project_guidelines.js";
// Filesystem Tools (Imported)
import { readFileTool } from "./read_file.js";
import { readMultipleFilesTool } from "./read_multiple_files.js";
import { writeFileTool } from "./write_file.js";
import { editFileTool } from "./edit_file.js";
import { createDirectoryTool } from "./create_directory.js";
import { listDirectoryTool } from "./list_directory.js";
import { directoryTreeTool } from "./directory_tree.js";
import { moveFileTool } from "./move_file.js";
import { moveMultipleFilesOrDirectoriesTool } from "./move_multiple_files_or_directories.js";
import { searchFilesTool } from "./search_files.js";
import { getFileInfoTool } from "./get_file_info.js";
// Import the new combined tools
import { saveGenerateProjectGuidelinesTool } from "./save_generate_project_guidelines.js";
import { saveDocSnippetTool } from "./save_doc_snippet.js";
import { saveTopicExplanationTool } from "./save_topic_explanation.js";
// Removed old save_query_answer, added new specific ones
import { saveAnswerQueryDirectTool } from "./save_answer_query_direct.js";
import { saveAnswerQueryWebsearchTool } from "./save_answer_query_websearch.js";

export const allTools: ToolDefinition[] = [
  // Query & Generation Tools
  answerQueryWebsearchTool,
  answerQueryDirectTool,
  explainTopicWithDocsTool,
  getDocSnippetsTool,
  generateProjectGuidelinesTool,
  // Filesystem Tools
  readFileTool,
  readMultipleFilesTool,
  writeFileTool,
  editFileTool,
  createDirectoryTool,
  listDirectoryTool,
  directoryTreeTool,
  moveFileTool,
  moveMultipleFilesOrDirectoriesTool,
  searchFilesTool,
  getFileInfoTool,
  // Add the new combined tools
  saveGenerateProjectGuidelinesTool,
  saveDocSnippetTool,
  saveTopicExplanationTool,
  // Removed old save_query_answer, added new specific ones
  saveAnswerQueryDirectTool,
  saveAnswerQueryWebsearchTool,
];

// Create a map for easy lookup
export const toolMap = new Map<string, ToolDefinition>(
  allTools.map((tool) => [tool.name, tool])
);
