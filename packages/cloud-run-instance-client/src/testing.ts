// Testing entrypoint — fake HttpTransport for the Cloud Run Instance client.
// NOT exported from the production index: import via
// `@cloud-run-dsh/cloud-run-instance-client/testing` from tests only.

import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from "./index.js";

export class FakeTransport implements HttpTransport {
  requests: HttpRequest[] = [];
  private handler: (req: HttpRequest) => Promise<HttpResponse>;

  constructor(handler?: (req: HttpRequest) => Promise<HttpResponse>) {
    this.handler =
      handler ??
      (async () => ({
        status: 200,
        body: { name: "fake-instance", state: "READY", url: "https://fake.run.app" },
      }));
  }

  setHandler(handler: (req: HttpRequest) => Promise<HttpResponse>): void {
    this.handler = handler;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    return this.handler(req);
  }

  lastRequest(): HttpRequest | undefined {
    return this.requests[this.requests.length - 1];
  }

  clear(): void {
    this.requests = [];
  }
}
