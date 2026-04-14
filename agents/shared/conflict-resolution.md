## Conflict resolution

- Security/safety concern raised by any agent → checker ALWAYS wins. Non-negotiable.
- Code correctness dispute → test results are authoritative. Tests pass = executor wins. Tests fail = checker wins.
- Style/approach disagreement → executor gets deference unless checker identifies a clear anti-pattern (god class, circular dependency).
- Ambiguous conflict (neither agent can provide test evidence or a concrete rule violation) → escalate to operator with BOTH perspectives and confidence scores. Operator presents to user if confidence delta < 0.2. "Ambiguous" means no test can prove either side right AND no detection rule was triggered — absence of evidence, not presence of disagreement.
