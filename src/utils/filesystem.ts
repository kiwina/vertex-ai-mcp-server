/**
 * Filesystem utility functions for MCP server
 */

import * as path from "node:path";
import fs from "fs/promises";
import { z } from "zod";
import { minimatch } from "minimatch";
import { createTwoFilesPatch } from "diff";
import { WORKSPACE_ROOT } from "../config.js";
import { EditOperationSchema } from "../tools/edit_file.js";

// Basic security check - ensure path stays within workspace
export function validateWorkspacePath(requestedPath: string): string {
  const absolutePath = path.resolve(process.cwd(), requestedPath);
  if (!absolutePath.startsWith(process.cwd())) {
    throw new Error(`Path traversal attempt detected: ${requestedPath}`);
  }
  return absolutePath;
}

export interface FileInfo {
  size: number;
  created: Date;
  modified: Date;
  accessed: Date;
  isDirectory: boolean;
  isFile: boolean;
  permissions: string;
}

export async function getFileStats(filePath: string): Promise<FileInfo> {
  const stats = await fs.stat(filePath);
  return {
    size: stats.size,
    created: stats.birthtime,
    modified: stats.mtime,
    accessed: stats.atime,
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    permissions: stats.mode.toString(8).slice(-3), // POSIX permissions
  };
}

export async function searchFilesRecursive(
  rootPath: string,
  currentPath: string,
  pattern: string,
  excludePatterns: string[],
  results: string[]
): Promise<void> {
  const entries = await fs.readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(currentPath, entry.name);
    const relativePath = path.relative(rootPath, fullPath);

    const shouldExclude = excludePatterns.some((p) =>
      minimatch(relativePath, p, { dot: true, matchBase: true })
    );
    if (shouldExclude) {
      continue;
    }

    if (entry.name.toLowerCase().includes(pattern.toLowerCase())) {
      results.push(path.relative(process.cwd(), fullPath));
    }

    if (entry.isDirectory()) {
      try {
        const realPath = await fs.realpath(fullPath);
        if (realPath.startsWith(rootPath)) {
          await searchFilesRecursive(
            rootPath,
            fullPath,
            pattern,
            excludePatterns,
            results
          );
        }
      } catch (e) {
        console.error(
          `Skipping search in ${fullPath}: ${(e as Error).message}`
        );
      }
    }
  }
}

export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function createUnifiedDiff(
  originalContent: string,
  newContent: string,
  filepath: string = "file"
): string {
  const normalizedOriginal = normalizeLineEndings(originalContent);
  const normalizedNew = normalizeLineEndings(newContent);
  return createTwoFilesPatch(
    filepath,
    filepath,
    normalizedOriginal,
    normalizedNew,
    "original",
    "modified"
  );
}

export async function applyFileEdits(
  filePath: string,
  edits: z.infer<typeof EditOperationSchema>[],
  dryRun = false
): Promise<string> {
  const content = normalizeLineEndings(await fs.readFile(filePath, "utf-8"));
  let modifiedContent = content;

  for (const edit of edits) {
    const normalizedOld = normalizeLineEndings(edit.oldText);
    const normalizedNew = normalizeLineEndings(edit.newText);

    if (modifiedContent.includes(normalizedOld)) {
      modifiedContent = modifiedContent.replace(normalizedOld, normalizedNew);
      continue;
    }

    const oldLines = normalizedOld.split("\n");
    const contentLines = modifiedContent.split("\n");
    let matchFound = false;

    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      const potentialMatch = contentLines.slice(i, i + oldLines.length);
      const isMatch = oldLines.every(
        (oldLine, j) => oldLine.trim() === potentialMatch[j].trim()
      );

      if (isMatch) {
        const originalIndent = contentLines[i].match(/^\s*/)?.[0] || "";
        const newLines = normalizedNew.split("\n").map((line, j) => {
          if (j === 0) return originalIndent + line.trimStart();
          const oldIndent = oldLines[j]?.match(/^\s*/)?.[0] || "";
          const newIndent = line.match(/^\s*/)?.[0] || "";
          if (oldIndent && newIndent) {
            const relativeIndent = newIndent.length - oldIndent.length;
            return (
              originalIndent +
              " ".repeat(Math.max(0, relativeIndent)) +
              line.trimStart()
            );
          }
          return line;
        });

        contentLines.splice(i, oldLines.length, ...newLines);
        modifiedContent = contentLines.join("\n");
        matchFound = true;
        break;
      }
    }

    if (!matchFound) {
      throw new Error(
        `Could not find exact or whitespace-insensitive match for edit:\n${edit.oldText}`
      );
    }
  }

  const diff = createUnifiedDiff(
    content,
    modifiedContent,
    path.relative(process.cwd(), filePath)
  );

  if (!dryRun) {
    await fs.writeFile(filePath, modifiedContent, "utf-8");
  }

  let numBackticks = 3;
  while (diff.includes("`".repeat(numBackticks))) {
    numBackticks++;
  }
  return `${"`".repeat(numBackticks)}diff\n${diff}\n${"`".repeat(
    numBackticks
  )}`;
}

export interface TreeEntry {
  name: string;
  type: "file" | "directory";
  children?: TreeEntry[];
}

export async function buildDirectoryTree(
  currentPath: string
): Promise<TreeEntry[]> {
  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  const result: TreeEntry[] = [];

  for (const entry of entries) {
    const entryData: TreeEntry = {
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
    };

    if (entry.isDirectory()) {
      const subPath = path.join(currentPath, entry.name);
      try {
        const realPath = await fs.realpath(subPath);
        if (realPath.startsWith(path.dirname(currentPath))) {
          entryData.children = await buildDirectoryTree(subPath);
        } else {
          entryData.children = [];
        }
      } catch (e) {
        entryData.children = [];
        console.error(
          `Skipping tree build in ${subPath}: ${(e as Error).message}`
        );
      }
    }
    result.push(entryData);
  }
  result.sort((a, b) => {
    if (a.type === "directory" && b.type === "file") return -1;
    if (a.type === "file" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name);
  });
  return result;
}

// Re-export existing utilities
export function sanitizePath(inputPath: string): string {
  const absolutePath = path.resolve(WORKSPACE_ROOT, inputPath);
  if (!absolutePath.startsWith(WORKSPACE_ROOT)) {
    throw new Error(
      `Access denied: Path is outside the workspace: ${inputPath}`
    );
  }
  // Basic check against path traversal
  if (absolutePath.includes("..")) {
    throw new Error(`Access denied: Invalid path component '..': ${inputPath}`);
  }
  return absolutePath;
}
