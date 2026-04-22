import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

// Create a fake Web Standard Request to see what happens
const fakeHeaders = new Headers({
  "accept": "application/json, text/event-stream",
  "content-type": "application/json"
});

const fakeRequest = new Request("http://localhost/mcp", {
  method: "POST",
  headers: fakeHeaders
});

console.log("Headers from fake request:", fakeRequest.headers);
console.log("Accept header:", fakeRequest.headers.get("accept"));
console.log("Includes application/json:", fakeRequest.headers.get("accept")?.includes("application/json"));
console.log("Includes text/event-stream:", fakeRequest.headers.get("accept")?.includes("text/event-stream"));

// Now test the condition
const acceptHeader = fakeRequest.headers.get('accept');
const result = !acceptHeader?.includes('application/json') || !acceptHeader.includes('text/event-stream');
console.log("SDK condition result (should be false for success):", result);
