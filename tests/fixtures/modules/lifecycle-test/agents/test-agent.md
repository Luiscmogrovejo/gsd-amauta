---
name: test-agent
description: Synthetic agent shipped by lifecycle-test module for Phase 49 tests.
---

# test-agent

This file exists solely so that Phase 49 install/uninstall tests can verify
`copy_agents` writes a file to `agents/test-agent.md` and `remove_agents`
deletes it on uninstall.
