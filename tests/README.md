# Tests (synthetic fixtures only — no production data)

Unit tests (no dependencies):

    node --test tests/*.test.mjs

Browser tests (load the real index.html in headless Chromium with Firebase stubbed) need a folder
with `playwright-core`, `react@18.2.0`, `react-dom@18.2.0` and `@babel/standalone@7.23.2` installed:

    npm i --prefix /tmp/sesanda-test-deps playwright-core react@18.2.0 react-dom@18.2.0 @babel/standalone@7.23.2
    TEST_DEPS=/tmp/sesanda-test-deps/node_modules CHROMIUM=/path/to/chrome node --test --test-concurrency=4 tests/*.test.mjs

Without TEST_DEPS the browser tests are skipped.
