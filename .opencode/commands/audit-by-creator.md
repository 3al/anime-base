---
description: >
  Audit an existing card against the very create-skill that produces it (note_kind → /new-<kind>): read the creator's text as source of truth, derive artifact invariants (sections, format, poster, gallery thumbnails, reciprocity), verify the card matches, score the authoring model's quality 1-10 and append it to the model-quality ledger. Catches under-implementation by weak models. Use when the user says /audit-by-creator, "сверь карточку с создающим скиллом", "аудит по создателю", "структурный аудит карточки", or for automatic background quality collection.
---
Invoke the `audit-by-creator` skill via the skill tool NOW.

User's arguments: $ARGUMENTS

Execute the skill's instructions IMMEDIATELY using the arguments above. Do not just acknowledge — perform the actions and report the result.
