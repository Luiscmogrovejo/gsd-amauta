#!/usr/bin/env python3
"""Grammar stripping for agent definitions — Phase 22 / CAVE-02.

Removes articles, filler words, and hedging from markdown text.
Preserves code blocks, YAML frontmatter, URLs, file paths, and XML tags.
"""

import re
import logging

log = logging.getLogger("gsd.grammar_strip")

# ── Word lists ──────────────────────────────────────────────────────────────

ARTICLES = {"a", "an", "the"}

FILLER_WORDS = {
    "just", "simply", "basically", "essentially", "very", "quite",
    "rather", "somewhat", "actually", "really", "certainly",
    "definitely", "probably", "literally", "practically",
}

HEDGING_PHRASES = [
    "it is important to note that",
    "it should be noted that",
    "it is possible that",
    "may want to consider",
    "could potentially",
    "might want to",
    "you might consider",
    "please note that",
    "keep in mind that",
    "you may want to",
]

# ── Compiled patterns ────────────────────────────────────────────────────────

# Single compiled regex for articles + filler words (word-boundary, case-insensitive)
_ALL_WORDS = sorted(ARTICLES | FILLER_WORDS, key=len, reverse=True)
_WORD_PATTERN = re.compile(
    r"\b(" + "|".join(re.escape(w) for w in _ALL_WORDS) + r")\b",
    re.IGNORECASE,
)

# Hedging phrase patterns (longer first to avoid partial matches)
_HEDGE_PATTERNS = [
    re.compile(r"\b" + re.escape(phrase) + r"\b", re.IGNORECASE)
    for phrase in sorted(HEDGING_PHRASES, key=len, reverse=True)
]

# URL pattern — do not strip inside URLs
_URL_PATTERN = re.compile(r"(?:https?|ftp)://\S+")

# File path pattern — starts with ./ ../ / ~ or contains /
_PATH_PATTERN = re.compile(r"(?:^|(?<=\s))(?:\.{1,2}/|/|~/)\S+")

# Inline code pattern — `...`
_INLINE_CODE_PATTERN = re.compile(r"`[^`\n]+`")

# Multiple spaces to single space (preserve intentional newlines)
_MULTI_SPACE = re.compile(r"[ \t]{2,}")


def _strip_line(line: str) -> str:
    """Strip articles, fillers, and hedging from a single text line.

    Preserves URLs, file paths, and inline code spans.
    """
    # Collect protected spans (URLs, file paths, inline code) as placeholders
    placeholders = {}
    placeholder_idx = [0]

    def protect(m):
        key = f"\x00PROTECTED_{placeholder_idx[0]}\x00"
        placeholders[key] = m.group(0)
        placeholder_idx[0] += 1
        return key

    # Protect inline code first (most common in markdown)
    protected = _INLINE_CODE_PATTERN.sub(protect, line)

    # Protect URLs
    protected = _URL_PATTERN.sub(protect, protected)

    # Protect file paths (rough heuristic)
    protected = _PATH_PATTERN.sub(protect, protected)

    # Remove hedging phrases first (multi-word, longer first)
    for pattern in _HEDGE_PATTERNS:
        protected = pattern.sub("", protected)

    # Remove articles and filler words
    protected = _WORD_PATTERN.sub("", protected)

    # Collapse multiple spaces/tabs (but not newlines)
    protected = _MULTI_SPACE.sub(" ", protected)

    # Strip leading/trailing whitespace from the line
    protected = protected.strip()

    # Restore placeholders
    for key, original in placeholders.items():
        protected = protected.replace(key, original)

    return protected


def strip_grammar(text: str) -> str:
    """Strip articles, filler words, and hedging from markdown text.

    Processes text line-by-line. Rules:
    - Preserves YAML frontmatter (--- delimiters at file start)
    - Preserves code blocks (triple-backtick fences)
    - Preserves inline code spans (`...`)
    - Preserves URLs (http://, https://, ftp://)
    - Preserves file paths (starts with ./, /, ~/, or contains /)
    - Removes articles: a, an, the
    - Removes filler words: just, simply, basically, essentially, very, quite,
      rather, somewhat, actually, really, certainly, definitely, probably,
      literally, practically
    - Removes hedging phrases: might want to, could potentially, etc.
    - Collapses resulting multiple spaces to single space
    - Returns the stripped text, never raises

    Args:
        text: Markdown text to strip.

    Returns:
        Grammar-stripped text, preserving markdown structure. Never raises.
    """
    try:
        lines = text.split("\n")
        result_lines = []

        in_code_block = False
        in_frontmatter = False
        frontmatter_count = 0  # count of --- delimiters seen

        for line in lines:
            stripped = line.strip()

            # ── YAML frontmatter detection ──────────────────────────────
            # Frontmatter is only valid at the very start of the file
            if not in_code_block and frontmatter_count == 0 and stripped == "---":
                in_frontmatter = True
                frontmatter_count = 1
                result_lines.append(line)
                continue

            if in_frontmatter:
                if stripped == "---":
                    in_frontmatter = False
                    frontmatter_count = 2
                    result_lines.append(line)
                    continue
                # Inside YAML frontmatter — strip values but preserve keys
                # Format: "key: value" — strip only the value part
                yaml_match = re.match(r'^(\s*[\w-]+\s*:\s*)(.*)', line)
                if yaml_match:
                    key_part = yaml_match.group(1)
                    val_part = yaml_match.group(2)
                    # Only strip if value is plain text (not quoted YAML scalars or lists)
                    if val_part and not val_part.startswith(("[", "{", "|", ">")):
                        # Handle quoted values: strip content but preserve quotes
                        quoted = re.match(r'^(["\'])(.*)\1$', val_part.strip())
                        if quoted:
                            inner = _strip_line(quoted.group(2))
                            val_part = f'{quoted.group(1)}{inner}{quoted.group(1)}'
                        else:
                            val_part = _strip_line(val_part)
                    result_lines.append(key_part + val_part)
                else:
                    result_lines.append(line)
                continue

            # ── Code block detection ────────────────────────────────────
            if stripped.startswith("```"):
                in_code_block = not in_code_block
                result_lines.append(line)
                continue

            # Inside code block — preserve verbatim
            if in_code_block:
                result_lines.append(line)
                continue

            # ── XML tag lines ────────────────────────────────────────────
            # Lines that are purely opening/closing XML tags are preserved as-is
            # e.g. <role>, </role>, <task id="...">, </task>
            if re.match(r'^\s*<[^>]+>\s*$', line):
                result_lines.append(line)
                continue

            # ── Normal text line — apply stripping ──────────────────────
            result_lines.append(_strip_line(line))

        return "\n".join(result_lines)

    except Exception as e:
        log.warning("strip_grammar_failed error=%s", str(e)[:200])
        # Return original text on any error
        return text


def strip_grammar_file(path: str) -> str:
    """Read a file and return grammar-stripped content.

    Convenience wrapper for processing agent .md files.

    Args:
        path: Path to the markdown file to process.

    Returns:
        Grammar-stripped text. Raises IOError/OSError on file read failure.
    """
    with open(path, "r", encoding="utf-8") as f:
        return strip_grammar(f.read())
