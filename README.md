# format-assert-generator

For a `schema/<version>` directory of a JSON Schema library, writes **`format-assert-fast/`** and **`format-assert-full/`**
copies in which every `format` is replaced by an equivalent `pattern` (see
[format-assert-compiler](../format-assert-compiler) and [ajv-formats-jsonschema](../ajv-formats-jsonschema)).
Useful for tools that do not assert `format` (API Gateway, code generators, ...).

```bash
npx format-assert-generator schema/0.0.0            # both modes
npx format-assert-generator schema/0.0.0 --mode fast --check   # CI: exit 1 when out of date
```

```
schema/0.0.0/
  a.schema.json
  ide/b.schema.json
  format-assert-fast/   <- generated, mirrors the tree above
    a.schema.json
    ide/b.schema.json
    .log.format-assert.json
  format-assert-full/
```

- **Input**: every `*.schema.json` below the directory, recursively (`ide/` included). Directories named `format-assert-*`
  (also nested ones), `.git` and `node_modules` are never read; other dot-directories are skipped unless asked for with
  `--include-dot-dirs` (all) or `--include-dot-dir .name` (repeatable) / `includeDotDirs` in the API, so re-running never consumes its own output.
- **Output**: the same relative paths below `format-assert-<mode>/`; indentation (tab/space) and trailing newline of each source are kept; output is deterministic.
- **`$id` / `$ref`**: the copies must not contradict the originals, so `$id` (and absolute `$ref`s into the same version) get
  `format-assert-<mode>/` inserted. Relative `$ref`s keep working in the mirrored tree; ones that climb out of the version
  directory get one more `../`. References to other libraries are untouched; to other versions untouched + a warning.
  (Implemented by `relocateSchema` in format-assert-compiler.)
- **Marker** `.log.format-assert.json` (generator and compiler versions, dictionary origin, source hashes). A `format-assert-*` directory is only ever cleared and rewritten
  when it contains the marker; otherwise the tool refuses. Deleted sources therefore disappear from the output.
- **Not convertible** (`regex`, `int32`, ... see ajv-formats-jsonschema `docs/FORMATS.md`): left as-is and listed; `--on-unresolved drop|error`, `--strict` (exit 1).
- `--source <url|file>` uses another dictionary (`{mode}` is replaced by `fast`/`full`); default is the one bundled with format-assert-compiler.

- **Lint** for the platform the patterns are going to: `--lint-regex re2` warns about lookahead / lookbehind / backreferences (RE2-based engines such as Go have none), `--max-pattern-length <n>` about long patterns. `--strict` turns lint warnings (and unconvertible formats) into exit code 1.

API: `generate({ versionDir, modes, source, compile, check, includeDotDirs, lint })`. Layout rules (`findSchemaFiles`, `isIgnoredDir`, directory names, marker name) come from [jsonschema-lib-layout](../jsonschema-lib-layout), shared with json-examples-validator.

Depends on `format-assert-compiler` (`file:../format-assert-compiler`, run `npm run build` there first).
