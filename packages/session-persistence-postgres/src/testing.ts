// Testing entrypoint — in-memory test double for the persistence repository.
// NOT exported from the production index: import via
// `@cloud-run-dsh/session-persistence-postgres/testing` from tests and local
// dev tooling only.

export { InMemoryFakeExecutor } from "./fakeExecutor.js";
