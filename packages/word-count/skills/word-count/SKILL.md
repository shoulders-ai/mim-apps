---
name: word-count
description: Use when the user asks for word counts, character counts, line counts, or text length with Word Count.
tools: &a1
  - word_count.analyze
unlocks: *a1
---

# Word Count

Call `word_count.analyze` when the user asks to count words in pasted text or a workspace file.

Ask for a file path or text if the request does not include either.
