---
name: Financial period duration preference
description: Why the configured duration is stored outside the accounting database.
---

Store the financial-period duration as a persistent app preference, while keeping period boundaries in the existing IndexedDB period records.

**Why:** This adds a durable setting without changing the IndexedDB schema or touching accounting entries and historical period identifiers.

**How to apply:** Keep future changes to this preference out of accounting-schema migrations unless backup or cross-device synchronization is explicitly required.
