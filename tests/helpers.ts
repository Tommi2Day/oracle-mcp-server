import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { vi, type Mock } from "vitest";

export type MockRes = ServerResponse & { writeHead: Mock; end: Mock };

/** Creates a mock request object that simulates a readable stream. */
export function makeReq(method: string, url: string,
  { headers = {}, body = "" }: { headers?: Record<string, string>; body?: string } = {}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = {
    authorization: `Bearer ${process.env.AUTH_TOKEN || ""}`,
    ...headers,
  };
  // Emit body chunks asynchronously so readBody() can attach listeners first
  setImmediate(() => {
    if (body) req.emit("data", body);
    req.emit("end");
  });
  return req;
}

/** Creates a mock response object. */
export function makeRes(): MockRes {
  return { writeHead: vi.fn(), end: vi.fn(), headersSent: false } as unknown as MockRes;
}

/** Parses the JSON body from res.end.mock.calls[0][0]. */
export function resBody(res: MockRes): any {
  return JSON.parse(res.end.mock.calls[0][0]);
}
