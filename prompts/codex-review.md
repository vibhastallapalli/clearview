# Codex accounts: reviewers and prompt writers

Codex doesn't write feature code here. Use it for:

**Review a PR.** Paste:
> Review PR #<n> on vibhastallapalli/clearview against AGENTS.md and PROJECT.md. Check: stays inside its owned files, money is integer cents, no fake success states, mocks/simulations labelled, AI output can't move money, approvals invalidated by evidence changes, no AI attribution. List blocking issues first, then nice-to-haves. Don't rewrite the code.

**Unblock an agent.** Paste the agent's error or question plus its prompt from `prompts/`, and ask Codex for the next prompt to give that agent.

**Integration check (after merges).** Paste:
> On main of vibhastallapalli/clearview, walk through the first milestone in TASKS.md and list anything that breaks the flow: upload → extraction → capture → review → approval → confirmed devnet payment.
