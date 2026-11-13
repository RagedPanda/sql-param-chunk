# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-11-13

### Changed

- Releases are published through npm trusted publishing (OIDC) instead of an npm token, so there is no long-lived token that could leak and publish a malicious version.

## [0.1.0] - 2026-11-13

### Added

- `chunkRows(rows, options)`, which splits rows into the fewest chunks whose multi-row insert stays under the bound-parameter limit, sized by the distinct columns across all rows, so rows with different keys can't overflow a chunk.
- `chunkValues(values, options)`, which does the same for `where id in (...)` lists, one parameter per value.
- `insertInChunks(rows, options)` and `queryInChunks(values, options)`, which run your `run(chunk)` on each chunk one at a time and resolve to the combined results, with `returning` rows concatenated in input order. Call them inside your own transaction to make the whole run atomic.
- Built-in limits for Cloudflare D1 (100), SQLite (32,766, or 999 before 3.32), Postgres (65,535), MySQL (65,535) and SQL Server (2,100), or any number, as `limit`.
- `extraParams` for parameters the rest of the statement binds, such as a `where tenant_id = ?` or `limit ? offset ?`, and `maxRows` for smaller chunks.
- `ChunkRunError`, which says which chunk failed and how many rows went in before it, so a non-transactional run can resume, and `RowTooLargeError` when one row doesn't fit on its own.
- ESM and CommonJS builds, each with its own types.

[Unreleased]: https://github.com/RagedPanda/sql-param-chunk/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/RagedPanda/sql-param-chunk/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/RagedPanda/sql-param-chunk/releases/tag/v0.1.0
