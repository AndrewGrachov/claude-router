// Facts the policy needs, derived from one Messages request body plus what the router remembers
// about the conversation. Pure: body and memory in, plain object out.

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']);
const FAILURE_WINDOW = 40;
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const CLIP_MARKER = ' […] ';
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-?]*[ -/]*[@-~]`, 'g');

export function extractFacts(body, memory, { recentTurns, maxTextChars }) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  // Claude Code puts hook output and tool additions in `system` messages after the user message, and keeps them in
  // the history: the turn is the last user or assistant message.
  const lastIndex = messages.findLastIndex((m) => m?.role !== 'system');
  const last = messages[lastIndex];
  const lastBlocks = blocks(last?.content);
  // The current user message goes to Jev as the prompt; `turns` holds only the dialogue before it.
  const current = last?.role === 'user' ? lastIndex : -1;
  const turns = [];
  const errors = [];
  const edits = [];
  messages.forEach((message, index) => {
    const content = blocks(message.content);
    if (message.role === 'user' && messages.length - 1 - index <= FAILURE_WINDOW) {
      for (const block of content)
        if (block.type === 'tool_result' && block.is_error) {
          const signature = signatureOf(block);
          if (signature) errors.push({ index, signature });
        }
    } else if (message.role === 'assistant') {
      for (const block of content) if (block.type === 'tool_use' && EDIT_TOOLS.has(block.name)) edits.push(index);
    }
    const text = textOf(content);
    if (index !== current && text && (message.role === 'user' || message.role === 'assistant'))
      turns.push({ role: message.role, text: clip(text, maxTextChars) });
  });
  return {
    turns: turns.slice(-recentTurns),
    prompt: current === -1 ? '' : clip(textOf(lastBlocks), maxTextChars),
    continuation: last?.role === 'user' && lastBlocks.some((b) => b.type === 'tool_result'),
    failure: repeatedFailure(errors, edits, messages.length - 1),
    // The effort Claude Code sent: a route without its own effort keeps it, and it is part of the cache key.
    effort: body.output_config?.effort ?? null,
    lastRoute: memory.lastRoute,
    lastRequest: memory.lastRequest,
    models: memory.models,
  };
}

// Two errors with the same signature and an edit attempt between them, all inside the recent window.
function repeatedFailure(errors, edits, lastIndex) {
  const recent = errors.filter((e) => lastIndex - e.index <= FAILURE_WINDOW);
  for (let j = recent.length - 1; j > 0; j -= 1) {
    for (let i = j - 1; i >= 0; i -= 1) {
      if (recent[i].signature !== recent[j].signature) continue;
      if (edits.some((k) => k > recent[i].index && k < recent[j].index))
        return { signature: recent[j].signature, index: recent[j].index };
    }
  }
  return null;
}

// At most `max` characters: the head and the tail of a long text, where a request and its question usually are.
export function clip(text, max) {
  if (text.length <= max) return text;
  if (max <= CLIP_MARKER.length) return text.slice(0, max);
  const room = max - CLIP_MARKER.length;
  const head = Math.ceil(room / 2);
  return `${text.slice(0, head)}${CLIP_MARKER}${text.slice(text.length - (room - head))}`;
}

function signatureOf(block) {
  const text = textOf(blocks(block.content))
    .replace(ANSI_ESCAPE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/^([ \t]*at[ \t]+[^\n]+\.[a-z]+):\d+(?::\d+)?(\)?)[ \t]*$/gim, '$1:#$2')
    .replace(/^([ \t]*location:[ \t]*['"]?[^\n'"]+\.[a-z]+):\d+(?::\d+)?(['"]?)[ \t]*$/gim, '$1:#$2')
    .replace(/^([ \t]*(?:#[ \t]*)?duration_ms:?[ \t]+)\d+(?:\.\d+)?[ \t]*$/gm, '$1#')
    .replace(/^([ \t]*✕[ \t]+.+) \(\d+(?:\.\d+)? ms\)$/gm, '$1 (# ms)')
    .trim();
  if (!text) return '';
  // FNV-1a keeps the full diagnostic in a bounded key without Node APIs in the Mod sandbox.
  // Unknown runner noise is kept: changed output conservatively counts as a new failure.
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1)
    hash = BigInt.asUintN(64, (hash ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n);
  return hash.toString(16);
}

function blocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function textOf(content) {
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text.replace(REMINDER, ''))
    .join('\n')
    .trim();
}

const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const DOC_PATH = /\.(?:md|mdx|rst|txt)$|(?:^|[\\/])docs[\\/]/i;
const READ_COMMANDS = new Set(['cat', 'ls', 'grep', 'rg', 'find', 'head', 'tail', 'cd']);
const READ_GIT = new Set(['status', 'log', 'diff', 'show']);
const SEPARATORS = /&&|\|\||[;|&\n]/;
// find can run or delete what it finds.
const WRITING_FIND = /\s-(?:exec|execdir|ok|okdir|delete)\b/;

// The index of the last user prompt, a user message that is not a tool result: where the latest turn starts. -1 when
// there is none.
export function promptIndex(messages) {
  return messages.findLastIndex(
    (m) => m?.role === 'user' && !blocks(m.content).some((block) => block?.type === 'tool_result'),
  );
}

// The bucket of a finished turn, from the tool calls the assistant made after the user message at `fromIndex`:
// code, docs, ops, read or talk. First match wins; only names and paths are read, no text is kept.
export function observedActivity(messages, fromIndex) {
  const calls = [];
  for (let i = fromIndex + 1; i < messages.length; i += 1)
    if (messages[i]?.role === 'assistant')
      for (const block of blocks(messages[i].content)) if (block.type === 'tool_use') calls.push(block);
  const edited = calls.filter((c) => FILE_EDIT_TOOLS.has(c.name));
  if (edited.length > 0) return edited.every((c) => DOC_PATH.test(editPath(c))) ? 'docs' : 'code';
  if (calls.some((c) => c.name === 'Bash' && !readsOnly(c.input?.command))) return 'ops';
  return calls.length > 0 ? 'read' : 'talk';
}

function editPath(call) {
  const path = call.input?.file_path ?? call.input?.notebook_path;
  return typeof path === 'string' ? path : '';
}

// Every command of a pipeline or list only reads. Command substitution runs inside double quotes, so it is looked for
// in the whole command; a literal one in single quotes counts too. Quoted text is then blanked, so a `;` or `>` inside
// a pattern is not taken for shell syntax. Anything unrecognised counts as running something.
function readsOnly(command) {
  if (typeof command !== 'string' || /`|\$\(/.test(command)) return false;
  const bare = command.replace(/'[^']*'|"[^"]*"/g, '""').replace(/\d?>\s*&\d|\d?>\s*\/dev\/null/g, '');
  if (/[<>]/.test(bare) || WRITING_FIND.test(bare)) return false;
  return bare.split(SEPARATORS).every((part) => {
    if (!part.trim()) return true;
    const [name, sub] = part.trim().split(/\s+/);
    return name === 'git' ? READ_GIT.has(sub) : READ_COMMANDS.has(name);
  });
}
