# SMS Category Confirmation Beta Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement the tasks independently and verify them together.

**Goal** — Run a separate iPhone SMS automation that presents a native category menu and writes a transaction only after selection.

**Architecture** — Reuse the production SMS privacy filters and parser. A beta request creates one ordinary pending inbox entry before the menu. A short-lived credential can confirm only that entry. The existing installation and recording preference keep their original behavior.

**Tech stack** — Apple Shortcuts, Python plist generation, Supabase/Postgres, PGlite and Vitest.

- Add and test isolated prepare and confirm RPCs. Cover pending before selection, category-only confirmation, duplicate delivery, invalid or expired confirmation, and the original automatic flow.
- Build an independently named shortcut from the verified production source. Audit its input guards, two network requests, menu branch, and defer branch.
- Verify the production project and publish the beta RPCs only after regression testing. Deliver the signed install file or the unsigned source with the approved signing path.
- Describe separate sender setup and the locked, unlocked, confirm, and defer checks for iPhone.
