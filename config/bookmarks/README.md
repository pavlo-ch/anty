# FB Acc bookmarklet

`fb-acc.txt` holds the single-line `javascript:` bookmarklet used for the **FB Acc**
default bookmark seeded into every profile.

- The file must contain exactly one line beginning with `javascript:`.
- If the file is missing or does not start with `javascript:`, the FB Acc bookmark
  falls back to the old `https://fbacc.io/` site and no migration runs — nothing breaks.
- When a valid file is present, new profiles get the bookmarklet, and existing profiles
  that still have the old `https://fbacc.io/` bookmark have it rewritten in place.

The payload is user-owned tooling (~25 KB) and is intentionally kept here as data, not
hardcoded in `src/main/launcher.js`, so it can be updated without a code change.
