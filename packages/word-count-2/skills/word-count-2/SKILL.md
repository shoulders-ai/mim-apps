---
name: word-count-2
description: Use when the user asks for word counts, character counts, line counts, or text length with Word Count 2.
tools: &a1
  - word_count_2.analyze
unlocks: *a1
---

# Word Count 2

Call `word_count_2.analyze` when the user asks to count words in pasted text or a workspace file.

Ask for a file path or text if the request does not include either.
