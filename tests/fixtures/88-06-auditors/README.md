Fixtures for tests/81-01, 82-01 and 83-01 (plan 88-06). Each auditor has a `clean/` tree that must produce zero
findings and a `seeded/` tree with exactly one planted instance per rule:

- infra/seeded/docker-compose.yml: image `myorg/web:latest` (INFRA-01). clean/ pins it by digest.
- agentic-flow/seeded: no token/cost budget ceiling anywhere (AGEN-04) and no cost event in EVENT_TYPES;
  1 agent eval set against a 3-agent roster (AGEN-06). clean/ has a ceiling, a cost event and eval parity.

Mutation check: remove the planted instance from a seeded tree and the matching test must fail.
