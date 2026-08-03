# Develop an Evolv Capability Pack

## Create a starter

1. Open **Marketplace** and enable **Developer Mode**.
2. Choose **Create new pack**.
3. Enter a unique `evolv.<name>` ID, description, category, agent instruction,
   and primary command prompt.
4. Save the generated `.evolvpack`.

The starter includes an agent, command, workflow, five example tasks, README,
changelog, configuration schema, and explicit permission declaration.

## Commands

A command is a prompt template, not executable code:

```json
{
  "id": "review-input",
  "name": "Review input",
  "description": "Perform a specialist review.",
  "agentId": "example-agent",
  "promptTemplate": "Review this evidence: {{input}}",
  "requiresApproval": false
}
```

`{{input}}` becomes the text entered in chat. The agent instruction applies
only to that turn. Disabled or uninstalled packs cannot resolve commands.

## Validate, install, and update

Use **Validate or install local pack**. Evolv parses it locally, displays
validation and permissions, and requires approval before installation.
Validation never runs pack content.

Increase the semantic version and update the changelog for an update. Evolv
shows permission differences and preserves the old version until the new
directory and registry record succeed.

After installation, use commands from **Marketplace → Pack commands** and use
pack details to configure, inspect diagnostics, disable, repair, export, update,
or uninstall.

## Design checklist

- Give the agent a narrow role and evidence standard.
- Add at least three commands and five example tasks.
- Keep workflows sequential and reviewable.
- Request the fewest permissions possible.
- Mark consequential uncertainty and escalation conditions.
- Put reusable material in `knowledge/`.
- Test install, disable, configuration, export, update, and uninstall.

The eight bundled definitions in `lib/marketplace.mjs` are complete examples.

