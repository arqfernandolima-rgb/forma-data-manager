# Contributing

Thanks for helping. This is a personal, best-effort project (see [DISCLAIMER.md](DISCLAIMER.md)).

- **Issues:** include the app version, what you expected, what happened, and the relevant History/log lines. **Never attach extracts, databases, query results or anything with project or customer data.**
- **Pull requests:** keep them focused, add or update tests (`cd engine && bun test`, `cd desktop && npm test`), and update the docs when behavior changes. See [docs/development.md](docs/development.md).
- **Accuracy changes:** if you find a query pattern that gives wrong numbers, the best fix is usually in the views (`engine/src/build/views.js`), with a test that reproduces the problem on the synthetic extract in `engine/test/helpers.js`.
- By contributing you agree your contribution is licensed under the [MIT License](LICENSE).
