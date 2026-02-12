import fs from 'fs';
import config from './config.js';

/**
 * Parse a JSONL conversation file from a byte offset, returning human-readable text.
 * Returns { text, newOffset } where newOffset is the end-of-file position.
 *
 * Claude Code JSONL format:
 * - Top-level entries have type: "user", "assistant", "system", "summary", etc.
 * - Content is in entry.message.content (string for user, array of blocks for assistant)
 * - Tool use blocks (type: "tool_use") appear inside assistant message content arrays
 * - Tool result blocks (type: "tool_result") appear inside user message content arrays
 */
export function parseConversationDelta(filePath, fromOffset = 0) {
  const stat = fs.statSync(filePath);
  if (stat.size <= fromOffset) {
    return { text: '', newOffset: fromOffset };
  }

  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(stat.size - fromOffset);
  fs.readSync(fd, buf, 0, buf.length, fromOffset);
  fs.closeSync(fd);

  const raw = buf.toString('utf-8');
  const lines = raw.split('\n').filter(l => l.trim());

  // Parse all lines into objects
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      continue;
    }
  }

  // Format with error chain detection
  const parts = formatWithChainDetection(entries);

  return {
    text: parts.join('\n'),
    newOffset: stat.size,
  };
}

/**
 * Walk entries sequentially, detecting error chains and compressing them.
 * Returns an array of formatted strings.
 */
function formatWithChainDetection(entries) {
  const parts = [];
  let i = 0;

  while (i < entries.length) {
    // Try to detect an error chain starting here
    const chain = tryDetectChain(entries, i);

    if (chain) {
      if (chain.attempts.length === 1) {
        // Single error: show the tool call + error marker, skip the error result entry
        const attempt = chain.attempts[0];
        for (const tu of attempt.toolUses) {
          parts.push(`[Tool: ${tu.name}] ${tu.summary}`);
        }
        parts.push(`[Tool error: ${attempt.errorBrief}]`);
      } else {
        // Chain of 2+: compressed summary replaces all error pairs
        parts.push(formatChainSummary(chain));
      }
      i = chain.endIndex;
      continue;
    }

    // Normal formatting
    const formatted = formatEntry(entries[i]);
    if (formatted.length > 0) {
      parts.push(...formatted);
    }
    i++;
  }

  return parts;
}

/**
 * Try to detect an error chain starting at index i.
 *
 * A chain is 1+ consecutive (assistant-with-tool_use, user-with-error-tool_result) pairs
 * for the same tool name. Text-only assistant messages between retries are skipped.
 *
 * Returns { attempts, endIndex } or null.
 * endIndex points to the first entry AFTER the chain (the resolution or next unrelated entry).
 */
function tryDetectChain(entries, startIndex) {
  const firstToolUses = getToolUses(entries[startIndex]);
  if (!firstToolUses) return null;

  const chainToolName = firstToolUses[0].name;

  // Detect parallel calls via message.id — JSONL splits parallel calls into
  // separate entries, but they share the same message.id from the API response.
  // Sequential retries have different message.ids.
  const firstMessageId = entries[startIndex].message?.id;

  // Next entry must be an all-error tool result
  const firstErrors = getErrorResults(entries[startIndex + 1]);
  if (!firstErrors) return null;

  const attempts = [{
    toolUses: firstToolUses,
    errors: firstErrors,
    errorBrief: classifyError(firstErrors),
  }];
  let i = startIndex + 2;

  while (i < entries.length) {
    // Skip text-only assistant messages between retries ("I need permission...")
    if (isTextOnlyMessage(entries[i])) {
      i++;
      continue;
    }

    const toolUses = getToolUses(entries[i]);
    if (!toolUses) break;

    // Parallel calls from the same API message share message.id — not retries.
    const msgId = entries[i].message?.id;
    if (msgId && firstMessageId && msgId === firstMessageId) break;

    if (toolUses[0].name !== chainToolName) break;

    const errors = getErrorResults(entries[i + 1]);
    if (errors) {
      attempts.push({
        toolUses: toolUses,
        errors: errors,
        errorBrief: classifyError(errors),
      });
      i += 2;
      continue;
    }

    // Not an error — chain ends. This entry (the successful retry) will format normally.
    break;
  }

  return { attempts, endIndex: i };
}

/**
 * Format a chain of 2+ errors into a compressed summary.
 */
function formatChainSummary(chain) {
  const { attempts } = chain;
  const count = attempts.length;
  const toolName = attempts[0].toolUses[0].name;

  // Check if all attempts used identical inputs
  const inputSigs = attempts.map(a => a.toolUses.map(t => t.summary).join(', '));
  const allIdentical = inputSigs.every(s => s === inputSigs[0]);

  // Check if all errors are the same type
  const errorBriefs = attempts.map(a => a.errorBrief);
  const sameError = errorBriefs.every(e => e === errorBriefs[0]);

  let summary = `[Retry chain: ${toolName} x${count} failed`;

  // Check what follows the chain (peek at the context from the last attempt)
  summary += ']';

  if (allIdentical) {
    // Blind retry — same input, same error
    summary += `\n  Input: ${inputSigs[0]}`;
    summary += `\n  Error: ${errorBriefs[0]}`;
  } else {
    // Adaptive retry — inputs changed
    summary += `\n  First: ${inputSigs[0]}`;
    summary += `\n  Last: ${inputSigs[count - 1]}`;
    if (sameError) {
      summary += `\n  Error: ${errorBriefs[0]}`;
    } else {
      summary += `\n  Last error: ${errorBriefs[count - 1]}`;
    }
  }

  return summary;
}

// ---- Helpers for chain detection ----

/**
 * Extract tool_use info from an assistant entry. Returns array or null.
 */
function getToolUses(entry) {
  if (!entry || entry.type !== 'assistant') return null;
  const content = entry.message?.content;
  if (!Array.isArray(content)) return null;

  const toolUses = content
    .filter(b => b.type === 'tool_use')
    .map(b => ({
      name: b.name || 'unknown',
      input: b.input || {},
      summary: summarizeToolInput(b.name || 'unknown', b.input || {}),
    }));

  return toolUses.length > 0 ? toolUses : null;
}

/**
 * Extract error results from a user entry.
 * Returns array of error texts, or null if the entry isn't all-errors.
 */
function getErrorResults(entry) {
  if (!entry) return null;
  if (entry.type !== 'user' && entry.type !== 'human') return null;
  const content = entry.message?.content;
  if (!Array.isArray(content)) return null;

  const toolResults = content.filter(b => b.type === 'tool_result');
  if (toolResults.length === 0) return null;

  const errors = toolResults.filter(b => b.is_error);
  // Only count if ALL results are errors (don't break partial-success messages)
  if (errors.length !== toolResults.length) return null;

  const errorTexts = errors.map(e => {
    const text = typeof e.content === 'string'
      ? e.content
      : Array.isArray(e.content)
        ? e.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
        : '';
    return text;
  });

  return errorTexts;
}

/**
 * Check if an entry is a text-only assistant message (no tool calls).
 */
function isTextOnlyMessage(entry) {
  if (!entry || entry.type !== 'assistant') return false;
  const content = entry.message?.content;
  if (!Array.isArray(content)) return typeof content === 'string';
  return content.every(b => b.type === 'text' || b.type === 'thinking');
}

/**
 * Classify errors into a brief description for the chain summary.
 */
function classifyError(errorTexts) {
  const combined = errorTexts.join(' ').toLowerCase();
  if (/permission/.test(combined)) return 'permission denied';
  if (/doesn.t want to proceed/.test(combined)) return 'user rejected';
  if (/timeout/.test(combined)) return 'timeout';
  // Extract first meaningful line from the error
  const firstError = errorTexts[0] || '';
  const firstLine = firstError.split('\n').find(l => l.trim()) || firstError;
  return truncateText(firstLine, 120);
}

// ---- Original formatting (unchanged for non-chain entries) ----

/**
 * Format a top-level JSONL entry into human-readable lines.
 * Returns an array of formatted strings.
 */
function formatEntry(obj) {
  const type = obj.type;
  const results = [];

  if (type === 'user' || type === 'human') {
    const msg = obj.message || obj;
    const content = msg.content;

    if (typeof content === 'string') {
      if (!obj.isMeta) {
        results.push(`[User]: ${content}`);
      }
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          if (!obj.isMeta) {
            results.push(`[User]: ${block.text}`);
          }
        } else if (block.type === 'tool_result') {
          // Errors are handled by chain detection — skip here
          if (block.is_error) continue;
          const resultContent = typeof block.content === 'string'
            ? block.content
            : (Array.isArray(block.content)
              ? block.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
              : '');
          if (resultContent) {
            results.push(`[Tool Result]: ${truncateText(resultContent, config.MAX_TOOL_RESULT_CHARS)}`);
          }
        }
      }
    }
  }

  if (type === 'assistant') {
    const msg = obj.message || obj;
    const content = msg.content;

    if (typeof content === 'string') {
      results.push(`[Assistant]: ${content}`);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          results.push(`[Assistant]: ${block.text}`);
        } else if (block.type === 'tool_use') {
          const name = block.name || 'unknown';
          const input = block.input || {};
          const summary = summarizeToolInput(name, input);
          results.push(`[Tool: ${name}] ${summary}`);
        }
      }
    }
  }

  return results;
}

function summarizeToolInput(toolName, input) {
  const name = toolName.toLowerCase();

  if (name === 'read' || name === 'readfile') {
    return input.file_path || input.path || JSON.stringify(input);
  }
  if (name === 'write' || name === 'writefile') {
    return `${input.file_path || input.path || '?'} (write)`;
  }
  if (name === 'edit') {
    return `${input.file_path || input.path || '?'} (edit)`;
  }
  if (name === 'bash') {
    const cmd = input.command || '';
    return truncateText(cmd, 200);
  }
  if (name === 'glob') {
    return `pattern: ${input.pattern || '?'}`;
  }
  if (name === 'grep') {
    return `pattern: ${input.pattern || '?'}`;
  }
  if (name === 'task') {
    return `${input.description || input.prompt?.slice(0, 100) || ''}`;
  }
  if (name === 'webfetch') {
    return `${input.url || '?'}`;
  }
  if (name === 'websearch') {
    return `query: ${input.query || '?'}`;
  }

  const keys = Object.keys(input);
  if (keys.length === 0) return '';
  const first = input[keys[0]];
  if (typeof first === 'string') return truncateText(first, 200);
  return truncateText(JSON.stringify(input), 200);
}

function truncateText(text, maxChars) {
  if (text.length <= maxChars) return text;
  const headLen = Math.floor(maxChars * 0.6);
  const tailLen = Math.floor(maxChars * 0.3);
  return `${text.slice(0, headLen)}\n... [truncated ${text.length - headLen - tailLen} of ${text.length} chars] ...\n${text.slice(-tailLen)}`;
}
