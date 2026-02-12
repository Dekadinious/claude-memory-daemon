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

  const parts = [];

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      // Skip malformed lines (partial writes from crashes)
      continue;
    }

    const formatted = formatEntry(obj);
    if (formatted.length > 0) {
      parts.push(...formatted);
    }
  }

  return {
    text: parts.join('\n'),
    newOffset: stat.size,
  };
}

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
      // Skip meta/command messages that aren't real user input
      if (!obj.isMeta) {
        results.push(`[User]: ${content}`);
      }
    } else if (Array.isArray(content)) {
      // User messages can contain tool_result blocks and text blocks
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          if (!obj.isMeta) {
            results.push(`[User]: ${block.text}`);
          }
        } else if (block.type === 'tool_result') {
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
        // Skip 'thinking' blocks — internal reasoning, not useful for observations
      }
    }
  }

  // Skip system, summary, progress, file-history-snapshot, queue-operation types
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

  // Generic fallback
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
