# ShopFast (test fixture)

A deliberately badly-architected Express store, used to exercise IronBase.
It is **not** meant to be run or copied. Every file here plants a specific smell
that the review should surface:

| Smell | Where |
| --- | --- |
| Everything in one file, no layering | `src/app.js` |
| In-memory sessions (blocks horizontal scaling) | `src/app.js` — the `sessions` object |
| Hardcoded API key and DB password | `src/app.js`, `src/db.js` |
| SQL built by string concatenation | `src/app.js` order and search routes |
| N+1 query inside a loop | `src/app.js` `/api/orders` |
| Synchronous file I/O in a request handler | `src/app.js` `/api/products` |
| Uploads written to local disk | `src/app.js` `/api/upload` |
| No error-handling middleware; errors swallowed | throughout |
| No caching layer for repeated expensive reads | `/api/products` |
| Unbounded query with no pagination | `/api/search` |
| No health check, no structured logging | whole app |
