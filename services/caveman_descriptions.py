#!/usr/bin/env python3
"""Caveman-compressed file descriptions — Phase 22 / CAVE-01.

Generates pipe-delimited structured descriptions for RPETD context.
Format: [function] | deps: [...] | touches: [...] | tests: [...] | [quality]

Compatible with ContextValidator.selective_refresh(description_fn=...).
"""

import os
import re
import glob as glob_mod
import logging

log = logging.getLogger("gsd.caveman_descriptions")

# Maximum output length
MAX_CHARS = 500

# File extension to language mapping
_EXT_MAP = {
    ".py": "python",
    ".cjs": "js",
    ".js": "js",
    ".ts": "ts",
    ".sql": "sql",
    ".md": "md",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
}


def _detect_language(path: str) -> str:
    """Return a language token based on file extension."""
    _, ext = os.path.splitext(path)
    return _EXT_MAP.get(ext.lower(), "other")


def _first_n_words(text: str, n: int = 10) -> str:
    """Return first n whitespace-separated words from text."""
    words = text.split()
    return " ".join(words[:n])


def _extract_function_summary(lines: list, lang: str) -> str:
    """Extract a short function/purpose summary from file lines (<=10 words)."""
    if lang == "python":
        # Look for docstring first
        in_docstring = False
        docstring_lines = []
        for line in lines:
            stripped = line.strip()
            if not in_docstring:
                if stripped.startswith('"""') or stripped.startswith("'''"):
                    quote = stripped[:3]
                    rest = stripped[3:]
                    if rest.endswith(quote) and len(rest) > 3:
                        # Single-line docstring
                        return _first_n_words(rest[:-3].strip())
                    in_docstring = True
                    if rest.strip():
                        docstring_lines.append(rest.strip())
                elif stripped.startswith("def ") or stripped.startswith("class "):
                    # Extract name from def/class line
                    name_match = re.match(r'^(?:def|class)\s+(\w+)', stripped)
                    if name_match:
                        return _first_n_words(name_match.group(1).replace("_", " "))
            else:
                if stripped.endswith('"""') or stripped.endswith("'''"):
                    if stripped not in ('"""', "'''"):
                        docstring_lines.append(stripped[:-3].strip())
                    if docstring_lines:
                        return _first_n_words(" ".join(docstring_lines))
                    in_docstring = False
                elif stripped:
                    docstring_lines.append(stripped)
                    if docstring_lines:
                        return _first_n_words(docstring_lines[0])

    elif lang in ("js", "ts"):
        for line in lines:
            stripped = line.strip()
            # JSDoc comment
            if stripped.startswith("* ") and not stripped.startswith("*/"):
                text = stripped.lstrip("* ").strip()
                if text and not text.startswith("@"):
                    return _first_n_words(text)
            # function/class/module.exports
            fn_match = re.match(r'^(?:export\s+)?(?:async\s+)?function\s+(\w+)', stripped)
            if fn_match:
                name = re.sub(r'([A-Z])', r' \1', fn_match.group(1)).strip()
                return _first_n_words(name)
            cls_match = re.match(r'^(?:export\s+)?class\s+(\w+)', stripped)
            if cls_match:
                name = re.sub(r'([A-Z])', r' \1', cls_match.group(1)).strip()
                return _first_n_words(name)
            exp_match = re.match(r'^module\.exports\s*=\s*\{?(.{0,40})', stripped)
            if exp_match:
                return _first_n_words("exports " + exp_match.group(1).strip())

    elif lang == "sql":
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("--"):
                comment = stripped.lstrip("-").strip()
                if comment:
                    return _first_n_words(comment)
            create_match = re.match(r'^CREATE\s+(?:TABLE|INDEX|FUNCTION|VIEW)\s+(\w+)', stripped, re.IGNORECASE)
            if create_match:
                return _first_n_words("create " + create_match.group(1).lower())
            alter_match = re.match(r'^ALTER\s+TABLE\s+(\w+)', stripped, re.IGNORECASE)
            if alter_match:
                return _first_n_words("alter table " + alter_match.group(1).lower())

    elif lang == "md":
        # Skip YAML frontmatter (--- ... ---) before scanning for headings
        in_frontmatter = False
        frontmatter_done = False
        frontmatter_line = 0
        for i, line in enumerate(lines):
            stripped = line.strip()
            if i == 0 and stripped == "---":
                in_frontmatter = True
                continue
            if in_frontmatter:
                if stripped == "---":
                    in_frontmatter = False
                    frontmatter_done = True
                    frontmatter_line = i
                continue
            if stripped.startswith("#"):
                heading = stripped.lstrip("#").strip()
                if heading:
                    return _first_n_words(heading)

    elif lang in ("json", "yaml"):
        # Describe top-level keys
        top_keys = []
        for line in lines[:20]:
            stripped = line.strip()
            key_match = re.match(r'^"?(\w[\w-]*)"?\s*[:=]', stripped)
            if key_match and len(top_keys) < 5:
                top_keys.append(key_match.group(1))
        if top_keys:
            return _first_n_words("keys: " + " ".join(top_keys))

    # Fallback: first non-empty, non-comment line (skipping YAML frontmatter)
    in_frontmatter = False
    for i, line in enumerate(lines):
        stripped = line.strip()
        if i == 0 and stripped == "---":
            in_frontmatter = True
            continue
        if in_frontmatter:
            if stripped == "---":
                in_frontmatter = False
            continue
        if stripped and not stripped.startswith("#") and not stripped.startswith("//") and not stripped.startswith("--") and stripped != "---":
            return _first_n_words(stripped)

    return "file"


def _extract_deps(lines: list, lang: str) -> list:
    """Extract dependency/import names from file lines."""
    deps = []
    seen = set()

    if lang == "python":
        for line in lines:
            stripped = line.strip()
            # from X import Y
            from_match = re.match(r'^from\s+([\w.]+)\s+import', stripped)
            if from_match:
                mod = from_match.group(1).split(".")[0]
                if mod not in seen:
                    seen.add(mod)
                    deps.append(mod)
            # import X (possibly: import X, Y)
            import_match = re.match(r'^import\s+([\w., ]+)', stripped)
            if import_match:
                for mod_raw in import_match.group(1).split(","):
                    mod = mod_raw.strip().split(".")[0].split(" as ")[0].strip()
                    if mod and mod not in seen:
                        seen.add(mod)
                        deps.append(mod)
            if len(deps) >= 8:
                break

    elif lang in ("js", "ts"):
        for line in lines:
            stripped = line.strip()
            # require('X') or require("X")
            req_match = re.findall(r'require\(["\']([^"\']+)["\']', stripped)
            for mod_path in req_match:
                # Get module name (strip relative path, keep package name)
                mod = mod_path.split("/")[0] if not mod_path.startswith(".") else os.path.basename(mod_path)
                if mod and mod not in seen:
                    seen.add(mod)
                    deps.append(mod)
            # import ... from 'X'
            from_match = re.findall(r'from\s+["\']([^"\']+)["\']', stripped)
            for mod_path in from_match:
                mod = mod_path.split("/")[0] if not mod_path.startswith(".") else os.path.basename(mod_path)
                if mod and mod not in seen:
                    seen.add(mod)
                    deps.append(mod)
            if len(deps) >= 8:
                break

    elif lang == "sql":
        for line in lines:
            stripped = line.strip()
            ref_match = re.findall(r'REFERENCES\s+(\w+)', stripped, re.IGNORECASE)
            for table in ref_match:
                if table not in seen:
                    seen.add(table)
                    deps.append(table)
            if len(deps) >= 8:
                break

    return deps[:8]


def _extract_touches(lines: list, lang: str) -> list:
    """Extract file pattern references from file lines."""
    patterns = []
    seen = set()

    # Common file extensions to look for
    file_ext_re = re.compile(r'["\']([^"\']*\.(?:py|cjs|js|ts|sql|md|json|yaml|yml)[^"\']*)["\']')
    # Path-like references
    path_re = re.compile(r'["\']([./~][^\s"\']{3,40})["\']')

    if lang == "python":
        for line in lines:
            stripped = line.strip()
            # open(...) calls
            open_match = re.findall(r'open\(["\']([^"\']+)["\']', stripped)
            for p in open_match:
                key = os.path.basename(p)
                if key not in seen:
                    seen.add(key)
                    patterns.append(key)
            # Path(...) references
            path_match = re.findall(r'Path\(["\']([^"\']+)["\']', stripped)
            for p in path_match:
                key = os.path.basename(p)
                if key not in seen:
                    seen.add(key)
                    patterns.append(key)
            # String literals with file extensions
            for m in file_ext_re.findall(stripped):
                key = os.path.basename(m)
                if key not in seen:
                    seen.add(key)
                    patterns.append(key)

    elif lang in ("js", "ts"):
        for line in lines:
            stripped = line.strip()
            # fs.readFileSync / fs.writeFileSync
            fs_match = re.findall(r'fs\.\w+\(["\']([^"\']+)["\']', stripped)
            for p in fs_match:
                key = os.path.basename(p)
                if key not in seen:
                    seen.add(key)
                    patterns.append(key)
            # require with relative paths
            rel_req = re.findall(r'require\(["\'](\.[^"\']+)["\']', stripped)
            for p in rel_req:
                key = os.path.basename(p)
                if key not in seen:
                    seen.add(key)
                    patterns.append(key)
            # String literals with file extensions
            for m in file_ext_re.findall(stripped):
                key = os.path.basename(m)
                if key not in seen:
                    seen.add(key)
                    patterns.append(key)

    else:
        # Generic: scan for path-like strings and extension-bearing strings
        for line in lines:
            stripped = line.strip()
            for m in file_ext_re.findall(stripped):
                key = os.path.basename(m)
                if key not in seen:
                    seen.add(key)
                    patterns.append(key)
            for m in path_re.findall(stripped):
                key = os.path.basename(m)
                if key not in seen:
                    seen.add(key)
                    patterns.append(key)

    return patterns[:5] if patterns else []


def _extract_test_ref(path: str) -> str:
    """Find matching test file and count test functions."""
    module_name = os.path.splitext(os.path.basename(path))[0]
    # Strip common prefixes for the search
    clean_name = module_name.replace("-", "_").replace(".", "_")

    # Search patterns: test_<name>.py, <name>.test.cjs, etc.
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(path)))
    tests_dir = os.path.join(project_root, "tests")

    if not os.path.isdir(tests_dir):
        return "none"

    candidates = []
    for fname in os.listdir(tests_dir):
        fname_clean = fname.replace("-", "_").replace(".", "_")
        if clean_name in fname_clean or (len(clean_name) > 4 and clean_name[:6] in fname_clean):
            candidates.append(fname)

    if not candidates:
        return "none"

    # Pick the best candidate (prefer test_<name>.py)
    best = None
    for c in candidates:
        if c.startswith("test_") and c.endswith(".py"):
            best = c
            break
    if best is None:
        best = candidates[0]

    test_path = os.path.join(tests_dir, best)
    try:
        with open(test_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        # Count test functions: def test_ (Python) or test(' / it(' (JS)
        py_tests = len(re.findall(r'^\s*def test_', content, re.MULTILINE))
        js_tests = len(re.findall(r"(?:test|it)\s*\(", content))
        count = py_tests or js_tests
        return f"{best}({count})" if count else best
    except (OSError, IOError):
        return best


def _count_loc(lines: list) -> int:
    """Count non-blank, non-comment lines."""
    count = 0
    for line in lines:
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and not stripped.startswith("//") and not stripped.startswith("--") and not stripped.startswith("*"):
            count += 1
    return count


def _count_exports(lines: list, lang: str) -> int:
    """Count exported functions, classes, or constants."""
    count = 0
    if lang == "python":
        for line in lines:
            stripped = line.strip()
            if re.match(r'^def \w+|^class \w+', stripped) and not stripped.startswith("_"):
                count += 1
    elif lang in ("js", "ts"):
        for line in lines:
            stripped = line.strip()
            if "module.exports" in stripped or stripped.startswith("export "):
                count += 1
    return count


def _truncate_to_limit(summary: str, deps: list, touches: list, test_ref: str, quality: str) -> str:
    """Build pipe-delimited string, truncating deps/touches if needed."""
    def build(deps_list, touches_list):
        deps_str = ", ".join(deps_list) if deps_list else "none"
        touches_str = ", ".join(touches_list) if touches_list else "self"
        return f"{summary} | deps: {deps_str} | touches: {touches_str} | tests: {test_ref} | {quality}"

    result = build(deps, touches)
    if len(result) <= MAX_CHARS:
        return result

    # Truncate deps first
    for n in range(len(deps) - 1, -1, -1):
        result = build(deps[:n], touches)
        if len(result) <= MAX_CHARS:
            return result

    # Then truncate touches
    for m in range(len(touches) - 1, -1, -1):
        result = build([], touches[:m])
        if len(result) <= MAX_CHARS:
            return result

    # Hard truncate
    result = build([], [])
    return result[:MAX_CHARS]


def generate_caveman_description(path: str) -> str:
    """Generate a pipe-delimited structured file description.

    Format: [function <=10w] | deps: [list] | touches: [patterns] | tests: [file(count)] | [quality]

    This function is pure: no network calls, no LLM calls, no subprocess.
    It reads only the file at `path` and optionally scans `tests/` for matching
    test files. It never raises — returns a fallback string on any error.

    Compatible with ContextValidator.selective_refresh(description_fn=...).

    Args:
        path: Absolute or relative path to the file to describe.

    Returns:
        Pipe-delimited description string, <= 500 chars. Never raises.
    """
    try:
        # Detect language
        lang = _detect_language(path)

        # Read file content
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
            lines = content.splitlines()
        except (OSError, IOError, UnicodeDecodeError):
            return f"unreadable | deps: none | touches: self | tests: none | 0 loc"

        if not lines:
            return f"empty file | deps: none | touches: self | tests: none | 0 loc"

        # Extract components
        summary = _extract_function_summary(lines, lang)
        deps = _extract_deps(lines, lang)
        touches = _extract_touches(lines, lang)
        test_ref = _extract_test_ref(path)
        loc = _count_loc(lines)
        exports = _count_exports(lines, lang)

        # Build quality signal
        if exports > 0:
            quality = f"{loc} loc, {exports} exports"
        else:
            quality = f"{loc} loc"

        result = _truncate_to_limit(summary, deps, touches, test_ref, quality)
        log.debug("caveman_desc path=%s len=%d", path, len(result))
        return result

    except Exception as e:
        log.warning("generate_caveman_description_failed path=%s error=%s", path, str(e)[:200])
        return f"error | deps: none | touches: self | tests: none | 0 loc"
