# Security Policy

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Report security issues by email to: **robertamautaai@gmail.com**

Include in your report:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (optional)

We acknowledge receipt within 48 hours and provide an initial assessment within 1 week.

## Disclosure Timeline

We follow a 90-day coordinated disclosure timeline from the date of acknowledgment.
After 90 days, the issue may be disclosed publicly regardless of patch status (with reasonable
extensions granted for critical infrastructure dependencies outside our control).

## Supported Versions

| Version | Support status |
|---------|---------------|
| v3.3.x  | Full support — security + bug fixes |
| v3.2.x  | Security fixes only |
| < v3.2  | Not supported — please upgrade |

## Scope

**In scope:**
- Code in this repository (bin/, services/, get-shit-done/, scripts/, migrations/)
- The `npx gsd-amauta init` installer and daemon startup
- The A2A agent-to-agent protocol implementation
- The module install/verify pipeline (signature verification, trusted-key store)

**Out of scope:**
- Vulnerabilities in third-party dependencies (PostgreSQL, Valkey, Node.js, Python)
  — please report these to the upstream projects
- Issues requiring physical access to the machine running the daemon
- Social engineering attacks

## Recognition

We credit security reporters in release notes unless you prefer anonymity.
